/**
 * Outbound Telegram client: `sendMessage` only (SPEC §5.6, plan G1T).
 *
 * ```ts
 * const telegram = createTelegramClient({
 *   token: config.secrets.telegramBotToken,
 *   apiBaseUrl: config.telegramApiUrl,      // TELEGRAM_API_URL; default https://api.telegram.org
 *   logger: logger.child({ module: "telegram" }),
 * });
 * await telegram.sendMessage({ chatId: "123456789", text: renderReminder({ items }) });
 * ```
 *
 * Design notes:
 * - **One request kind.** No `editMessageText`, no media, no polling/webhook: the bot only
 *   broadcasts (SPEC §5.6), so a smaller surface is a smaller security surface.
 * - **No retry.** N1 owns the decision to retry; the client either sends or throws
 *   {@link TelegramError}. `sendMessage` is therefore not idempotent — calling it twice sends
 *   two messages.
 * - **HTML by default.** `parse_mode: "HTML"` is set here (once), so templates must escape
 *   user data — see `escapeHtml` in `./bindings.ts`. A raw `<` (e.g. «a < b») makes Telegram
 *   answer `400 Bad Request: can't parse entities`, i.e. the whole message is lost.
 * - **Secrets stay out of logs.** The bot token lives in the request *path*, so neither the
 *   URL nor the full error dump is logged; only the chat id, sizes and the Telegram error
 *   `description` (which never contains the token).
 */

import type { Logger } from "../config/logger.js";
import type { TelegramSender } from "../contracts/notify.js";

/** Default Bot API origin; `TELEGRAM_API_URL` overrides it (e2e against a local mock server). */
export const DEFAULT_TELEGRAM_API_URL = "https://api.telegram.org";

/** Default HTTP timeout of one `sendMessage`. Telegram answers in well under a second when healthy. */
export const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;

/** Telegram's hard limit for one message (`sendMessage` rejects longer text). */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

export type TelegramErrorCode =
  /** DNS/TCP/TLS failure, connection reset, or a response body that cannot be read. */
  | "network"
  /** `timeoutMs` elapsed before a complete response. */
  | "timeout"
  /** Telegram answered, but with `ok: false` (bad token, bad HTML, blocked bot, …). */
  | "telegram_api"
  /** Arguments the Bot API would reject anyway (empty chat id, empty/oversized text). */
  | "invalid_input";

/** Any failed send. Carries the Telegram `error_code`/`description` verbatim: dropping them hides «can't parse entities». */
export class TelegramError extends Error {
  readonly code: TelegramErrorCode;
  /** HTTP status when a response was received. */
  readonly status: number | undefined;
  /** Telegram's `description` or the transport error message. */
  readonly description: string | undefined;

  constructor(
    code: TelegramErrorCode,
    message: string,
    options: { status?: number; description?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TelegramError";
    this.code = code;
    this.status = options.status;
    this.description = options.description;
  }
}

export interface CreateTelegramClientOptions {
  /** Bot token from @BotFather (`TELEGRAM_BOT_TOKEN`). Never logged. */
  readonly token: string;
  /** Bot API origin; `TELEGRAM_API_URL` in production, a `127.0.0.1` mock in e2e. */
  readonly apiBaseUrl?: string;
  readonly logger?: Logger;
  /** Per-request timeout; defaults to {@link DEFAULT_TELEGRAM_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

interface TelegramApiResponse {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** Trims trailing slashes so `apiBaseUrl` may be written as `http://127.0.0.1:8080/`. */
function normalizeBaseUrl(value: string, logger?: Logger): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "") throw new TelegramError("invalid_input", "Telegram API base URL is empty");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TelegramError("invalid_input", `Telegram API base URL is not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TelegramError("invalid_input", `Telegram API base URL must be http(s), got ${url.protocol}`);
  }
  logger?.debug("telegram api base url", { apiBaseUrl: trimmed });
  return trimmed;
}

/** `chat_id` as the Bot API accepts it: a numeric id (groups are negative) or `@channelname`. */
function validateChatId(chatId: string): string {
  const value = chatId.trim();
  if (value === "") throw new TelegramError("invalid_input", "chat id must not be empty");
  if (!/^-?\d+$/.test(value) && !/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(value)) {
    throw new TelegramError("invalid_input", `chat id must be numeric or @channel, got "${value}"`);
  }
  return value;
}

function validateText(text: string): string {
  if (text.trim() === "") throw new TelegramError("invalid_input", "message text must not be empty");
  // Telegram counts UTF-16 code units against the 4096 cap.
  if (text.length > TELEGRAM_MAX_TEXT_LENGTH) {
    throw new TelegramError(
      "invalid_input",
      `message text is ${text.length} characters, the Telegram limit is ${TELEGRAM_MAX_TEXT_LENGTH}`,
    );
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds the sender. No I/O here: the first network call happens on `sendMessage`. */
export function createTelegramClient(options: CreateTelegramClientOptions): TelegramSender {
  const token = options.token.trim();
  if (token === "") throw new TelegramError("invalid_input", "TELEGRAM_BOT_TOKEN is empty");
  const baseUrl = normalizeBaseUrl(options.apiBaseUrl ?? DEFAULT_TELEGRAM_API_URL, options.logger);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TelegramError("invalid_input", `timeoutMs must be a positive number, got ${timeoutMs}`);
  }
  const logger = options.logger;
  // Token is only ever concatenated here, never logged or attached to errors.
  const endpoint = `${baseUrl}/bot${token}/sendMessage`;

  return {
    async sendMessage(input: { chatId: string; text: string }): Promise<void> {
      const chatId = validateChatId(input.chatId);
      const text = validateText(input.text);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();

      let response: Response;
      let raw: string;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
          signal: controller.signal,
        });
        raw = await response.text();
      } catch (error) {
        const timedOut = controller.signal.aborted;
        const durationMs = Date.now() - startedAt;
        const failure = new TelegramError(
          timedOut ? "timeout" : "network",
          timedOut
            ? `Telegram did not answer within ${timeoutMs} ms`
            : `Telegram request failed: ${errorMessage(error)}`,
          { cause: error },
        );
        logger?.error("telegram send failed", { chatId, durationMs, code: failure.code, error });
        throw failure;
      } finally {
        clearTimeout(timer);
      }

      const durationMs = Date.now() - startedAt;
      let payload: TelegramApiResponse | null = null;
      try {
        payload = JSON.parse(raw) as TelegramApiResponse;
      } catch {
        payload = null;
      }

      const ok = payload?.ok === true;
      if (response.ok && ok) {
        logger?.debug("telegram message sent", {
          chatId,
          textLength: text.length,
          durationMs,
          messageId: messageIdOf(payload),
        });
        return;
      }

      // 2xx without a parseable body is unexpected but not a send failure; a non-2xx /
      // `ok:false` is, and keeps Telegram's own wording (parse errors live in `description`).
      if (response.ok && payload === null) {
        logger?.warn("telegram returned a non-JSON 2xx body", { chatId, durationMs, status: response.status });
        return;
      }

      const description = payload?.description ?? (response.ok ? "Telegram answered ok:false" : raw.slice(0, 500));
      const status = payload?.error_code ?? response.status;
      const failure = new TelegramError("telegram_api", `Telegram API error ${status}: ${description}`, {
        status,
        description,
      });
      logger?.error("telegram api rejected the message", {
        chatId,
        durationMs,
        status,
        description,
        ...(payload?.parameters?.retry_after === undefined
          ? {}
          : { retryAfterSeconds: payload.parameters.retry_after }),
      });
      throw failure;
    },
  };
}

function messageIdOf(payload: TelegramApiResponse | null): number | undefined {
  const result = payload?.result;
  if (result !== null && typeof result === "object" && "message_id" in result) {
    const id = (result as { message_id?: unknown }).message_id;
    return typeof id === "number" ? id : undefined;
  }
  return undefined;
}
