/**
 * OpenAI Chat Completions wire format (S2). Contract: `src/contracts/openai.ts`.
 *
 * M1 scope: text in, text out. The request is parsed leniently (OpenWebUI sends many extra
 * fields), the last user message becomes the durable input, and the answer is wrapped as
 * `chat.completion` or as the chunk sequence R1 verified (K5):
 * `role` delta → content delta(s) → finish chunk → `data: [DONE]` (the terminator lives in
 * `./sse.ts`).
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import type { TurnResult } from "../contracts/harness.js";
import {
  MODEL_ID,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatContent,
  type ChatContentPart,
  type ChatMessage,
  type ChatRole,
  type ChunkDelta,
  type CompletionBase,
  type CompletionUsage,
  type FinishReason,
  type MappedInput,
  type MapInputOptions,
} from "../contracts/openai.js";

/** Roles OpenWebUI is allowed to send; anything else is a malformed request, not a new feature. */
const CHAT_ROLES: readonly ChatRole[] = ["system", "user", "assistant"];

/** Some max chunk size keeps the synthetic echo stream readable in OpenWebUI's UI. */
export const DEFAULT_DELTA_CHARS = 24;

/** Usage of a turn that cost nothing (M1 echo: no model, K6). */
export const ZERO_USAGE: CompletionUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

/**
 * The request body is invalid (400). Separate from `AuthError`/`ConfigError` so the route can
 * render an OpenAI-shaped body without knowing which layer complained.
 */
export class InvalidRequestError extends Error {
  /** `error.code` of the OpenAI error body, e.g. `invalid_messages`. */
  readonly code: string;

  constructor(message: string, code = "invalid_request") {
    super(message);
    this.name = "InvalidRequestError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseContentPart(raw: unknown, index: number): ChatContentPart {
  if (!isRecord(raw)) {
    throw new InvalidRequestError(`messages[${index}]: content part must be an object`, "invalid_messages");
  }
  if (raw.type === "text") {
    if (typeof raw.text !== "string") {
      throw new InvalidRequestError(`messages[${index}]: text part needs a string "text"`, "invalid_messages");
    }
    return { type: "text", text: raw.text };
  }
  if (raw.type === "image_url") {
    const imageUrl = raw.image_url;
    if (!isRecord(imageUrl) || typeof imageUrl.url !== "string") {
      throw new InvalidRequestError(
        `messages[${index}]: image_url part needs { image_url: { url } }`,
        "invalid_messages",
      );
    }
    const { url, detail } = imageUrl;
    return {
      type: "image_url",
      image_url: detail === "auto" || detail === "low" || detail === "high" ? { url, detail } : { url },
    };
  }
  // Unknown part types (audio, file, …) are outside the contract; rejecting keeps the failure
  // visible instead of silently answering about a file we ignored.
  throw new InvalidRequestError(`messages[${index}]: unsupported content part "${String(raw.type)}"`, "invalid_messages");
}

function parseContent(raw: unknown, index: number): ChatContent {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((part) => parseContentPart(part, index));
  throw new InvalidRequestError(`messages[${index}]: content must be a string or an array of parts`, "invalid_messages");
}

function parseMessage(raw: unknown, index: number): ChatMessage {
  if (!isRecord(raw)) {
    throw new InvalidRequestError(`messages[${index}] must be an object`, "invalid_messages");
  }
  const role = raw.role;
  if (typeof role !== "string" || !CHAT_ROLES.includes(role as ChatRole)) {
    throw new InvalidRequestError(
      `messages[${index}]: role must be one of ${CHAT_ROLES.join(", ")}`,
      "invalid_messages",
    );
  }
  const content = parseContent(raw.content, index);
  return typeof raw.name === "string" ? { role: role as ChatRole, content, name: raw.name } : { role: role as ChatRole, content };
}

/**
 * Validates a request body into {@link ChatCompletionRequest}. Unknown fields are ignored on
 * purpose (OpenWebUI sends `max_tokens`, `top_p`, `stop`, `metadata`, …).
 *
 * `model` is not enforced: OpenWebUI may keep the id from an already saved chat, and M1 has a
 * single echo behaviour anyway — rejecting it would only break clients.
 */
export function parseChatCompletionRequest(body: unknown): ChatCompletionRequest {
  if (!isRecord(body)) {
    throw new InvalidRequestError("Request body must be a JSON object", "invalid_body");
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new InvalidRequestError("messages must be a non-empty array", "invalid_messages");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new InvalidRequestError("stream must be a boolean", "invalid_body");
  }
  const parsedMessages = messages.map((message, index) => parseMessage(message, index));
  const request: ChatCompletionRequest = {
    model: typeof body.model === "string" ? body.model : MODEL_ID,
    messages: parsedMessages,
    ...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
    ...(isRecord(body.stream_options) && typeof body.stream_options.include_usage === "boolean"
      ? { stream_options: { include_usage: body.stream_options.include_usage } }
      : {}),
  };
  return request;
}

// ---------------------------------------------------------------------------
// Request → durable input
// ---------------------------------------------------------------------------

/** Plain text of one message content (text parts joined; non-text parts ignored). */
export function messageText(content: ChatContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ChatContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * K10: the durable input is the **text** of the last user message; image parts are counted only.
 *
 * Decoding belongs to the upload path, not to this pure mapper: `src/server/images.ts` turns the
 * `data:` URLs into stored photos and appends their ids to the text (I2), and the agent passes those
 * ids to `submit_check_in`. `images` therefore counts what was *seen*, which is what the route logs
 * and what decides whether the decoder runs at all.
 */
export function mapMessagesToInput(
  messages: readonly ChatMessage[],
  // M1 does not decode images, so the limits are inert; kept so callers can pass them once
  // P1 lands and the mapping actually extracts bytes.
  options: MapInputOptions = {},
): MappedInput {
  void options;
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (lastUser === undefined) {
    throw new InvalidRequestError("messages must contain at least one user message", "missing_user_message");
  }
  let images = 0;
  if (typeof lastUser.content !== "string") {
    images = lastUser.content.filter((part) => part.type === "image_url").length;
  }
  const text = messageText(lastUser.content);
  const input: UserInput = text;
  return { input, text, images };
}

// ---------------------------------------------------------------------------
// Response building
// ---------------------------------------------------------------------------

/** Text → delta-sized slices of at most `maxChars` (deterministic; no model involved). */
export function splitText(text: string, maxChars: number = DEFAULT_DELTA_CHARS): string[] {
  if (maxChars < 1) throw new RangeError("maxChars must be >= 1");
  const deltas: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxChars) {
    deltas.push(text.slice(offset, offset + maxChars));
  }
  return deltas;
}

/** K5 step 1–2: role-only opening delta or one text delta. */
export function chunkFromDelta(base: CompletionBase, delta: ChunkDelta): ChatCompletionChunk {
  return {
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

/** K5 step 3: empty delta, real `finish_reason`, optional usage. */
export function finishChunk(
  base: CompletionBase,
  reason: FinishReason,
  usage?: CompletionUsage,
): ChatCompletionChunk {
  return {
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * K5: pi-ai `stopReason` → OpenAI `finish_reason`. `aborted`/`error`/`pending`/`deferred` still
 * need a terminating reason (the client already saw deltas), so they report `"stop"`; an aborted
 * turn is not an error response.
 */
export function finishReasonFromTurn(turn: Pick<TurnResult, "status" | "stopReason">): FinishReason {
  // `unanswered` carries no answer entry, so there is no stop reason to translate.
  if (turn.status === "unanswered") return "stop";
  switch (turn.stopReason) {
    case "length":
      return "length";
    case "toolUse":
      return "tool_calls";
    default:
      return "stop";
  }
}

/** K12: pi-ai `Usage` → OpenAI's token field names. */
export function usageFromPiUsage(usage: Usage): CompletionUsage {
  const total = usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output;
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: total,
  };
}

/** The non-streaming answer (`object: "chat.completion"`). */
export function chatCompletionResponse(
  base: CompletionBase,
  text: string,
  usage: CompletionUsage = ZERO_USAGE,
  finishReason: FinishReason = "stop",
): ChatCompletionResponse {
  return {
    id: base.id,
    object: "chat.completion",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
    usage,
  };
}

/**
 * K5: a complete chunk sequence for an already known answer — the M1 echo path. M2 streams the
 * same shapes from `Core.watchText` instead (see `TurnRunner` in `./routes.ts`).
 */
export function chunksForText(
  base: CompletionBase,
  text: string,
  options: { finishReason?: FinishReason; usage?: CompletionUsage; deltaChars?: number } = {},
): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = [chunkFromDelta(base, { role: "assistant" })];
  for (const delta of splitText(text, options.deltaChars ?? DEFAULT_DELTA_CHARS)) {
    chunks.push(chunkFromDelta(base, { content: delta }));
  }
  chunks.push(finishChunk(base, options.finishReason ?? "stop", options.usage ?? ZERO_USAGE));
  return chunks;
}
