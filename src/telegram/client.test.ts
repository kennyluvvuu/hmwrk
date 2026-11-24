import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../config/logger.js";
import { parseEnv } from "../config/env.js";
import { ConfigError } from "../config/errors.js";
import {
  createTelegramClient,
  DEFAULT_TELEGRAM_API_URL,
  TELEGRAM_MAX_TEXT_LENGTH,
  TelegramError,
  type TelegramErrorCode,
} from "./client.js";

const TOKEN = "123456:secret-token-value";

interface Call {
  url: string;
  init: RequestInit;
}

/** Installs a fake `fetch` that records calls and answers with `respond`. */
function stubFetch(respond: (call: Call) => Promise<Response> | Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Logger that keeps its lines in memory, so a leaked token is detectable. */
function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
  return { logger, lines };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createTelegramClient", () => {
  it("POSTs sendMessage to the default API origin with parse_mode HTML", async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, result: { message_id: 42 } }));
    const client = createTelegramClient({ token: TOKEN });

    await client.sendMessage({ chatId: "123456789", text: "Завтра сдать: математика" });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${DEFAULT_TELEGRAM_API_URL}/bot${TOKEN}/sendMessage`);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      chat_id: "123456789",
      text: "Завтра сдать: математика",
      parse_mode: "HTML",
    });
  });

  it("honours apiBaseUrl (e2e mock server) and trims trailing slashes", async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, result: { message_id: 1 } }));
    const client = createTelegramClient({ token: TOKEN, apiBaseUrl: "http://127.0.0.1:8080/" });

    await client.sendMessage({ chatId: "-100500", text: "hi" });

    expect(calls[0]?.url).toBe(`http://127.0.0.1:8080/bot${TOKEN}/sendMessage`);
  });

  it("rejects a non-http apiBaseUrl at construction", () => {
    expect(() => createTelegramClient({ token: TOKEN, apiBaseUrl: "file:///tmp" })).toThrow(TelegramError);
    expect(() => createTelegramClient({ token: "  " })).toThrow(/TELEGRAM_BOT_TOKEN is empty/);
  });

  it("raises telegram_api with Telegram's own description on 400 parse_error", async () => {
    stubFetch(() =>
      jsonResponse(400, {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities: Unsupported start tag \"b\"",
        parameters: { retry_after: 3 },
      }),
    );
    const { logger, lines } = captureLogger();
    const client = createTelegramClient({ token: TOKEN, logger });

    const error = await client.sendMessage({ chatId: "1", text: "<b>broken" }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TelegramError);
    const failure = error as TelegramError;
    expect(failure.code).toBe("telegram_api" satisfies TelegramErrorCode);
    expect(failure.status).toBe(400);
    expect(failure.description).toContain("can't parse entities");
    expect(failure.message).toContain("400");
    // The description is logged (it is actionable), the token and the URL are not.
    expect(lines.join("\n")).toContain("can't parse entities");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("maps a transport failure to code network", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const client = createTelegramClient({ token: TOKEN });

    const error = (await client.sendMessage({ chatId: "1", text: "hi" }).catch((reason: unknown) => reason)) as TelegramError;

    expect(error).toBeInstanceOf(TelegramError);
    expect(error.code).toBe("network");
    expect(error.message).toContain("fetch failed");
  });

  it("aborts after timeoutMs and reports code timeout", async () => {
    stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          // A stalled Telegram: only the abort signal ever settles this promise.
          call.init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = createTelegramClient({ token: TOKEN, timeoutMs: 25 });

    const error = (await client.sendMessage({ chatId: "1", text: "hi" }).catch((reason: unknown) => reason)) as TelegramError;

    expect(error).toBeInstanceOf(TelegramError);
    expect(error.code).toBe("timeout");
    expect(error.message).toContain("25 ms");
  });

  it("rejects empty/oversized input without touching the network", async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, result: {} }));
    const client = createTelegramClient({ token: TOKEN });

    await expect(client.sendMessage({ chatId: "1", text: "   " })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(client.sendMessage({ chatId: "", text: "hi" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(client.sendMessage({ chatId: "not a chat", text: "hi" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      client.sendMessage({ chatId: "1", text: "x".repeat(TELEGRAM_MAX_TEXT_LENGTH + 1) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  it("never logs the bot token on success", async () => {
    stubFetch(() => jsonResponse(200, { ok: true, result: { message_id: 7 } }));
    const { logger, lines } = captureLogger();
    const client = createTelegramClient({ token: TOKEN, logger });

    await client.sendMessage({ chatId: "1", text: "hi" });

    expect(lines.join("\n")).toContain("telegram message sent");
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).toContain('"messageId":7');
  });
});

describe("TELEGRAM_API_URL", () => {
  const required = { HMWRK_PARENT_KEY: "p", HMWRK_CHILD_KEY: "c" };

  /** `parseEnv` reports problems in `ConfigError.problems`, not in the message. */
  function problemsFor(value: string): { key: string; reason: string }[] {
    try {
      parseEnv({ ...required, TELEGRAM_API_URL: value });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return [...(error as ConfigError).problems];
    }
    throw new Error(`expected TELEGRAM_API_URL=${value} to be rejected`);
  }

  it("is optional and parsed into the config", () => {
    expect(parseEnv(required).TELEGRAM_API_URL).toBeUndefined();
    expect(parseEnv({ ...required, TELEGRAM_API_URL: "" }).TELEGRAM_API_URL).toBeUndefined();
    expect(parseEnv({ ...required, TELEGRAM_API_URL: "http://127.0.0.1:8080" }).TELEGRAM_API_URL).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("rejects values that are not http(s) URLs", () => {
    expect(problemsFor("127.0.0.1:8080")).toEqual([
      { key: "TELEGRAM_API_URL", reason: "must be an http(s) URL" },
    ]);
    expect(problemsFor("ftp://example.com")).toEqual([
      { key: "TELEGRAM_API_URL", reason: "must be an http(s) URL" },
    ]);
  });
});
