/**
 * Module contract: the OpenAI Chat Completions wire format (SPEC §3, §6), implemented by S2 in
 * `src/server/**`.
 *
 * Scope is what OpenWebUI actually sends and needs, not the whole OpenAI API: one `hmwrk` model,
 * text (and, from M2, image) input, streamed or not. Shapes follow OpenAI's documented
 * `chat.completion` / `chat.completion.chunk` objects and the SSE sequence R1 verified (K5).
 */

import type { UserInput } from "@earendil-works/pi-durable";
import type { TurnResult } from "./harness.js";

/** The single model id visible in OpenWebUI (SPEC §6); `GET /v1/models` returns exactly this. */
export const MODEL_ID = "hmwrk";

/** `GET /v1/models` owner label. */
export const MODEL_OWNER = "hmwrk";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Chat roles OpenWebUI sends. `tool`/`function` are out of scope: tools run inside the agent. */
export type ChatRole = "system" | "user" | "assistant";

/** Text part of a multi-part message. */
export interface ChatTextPart {
  readonly type: "text";
  readonly text: string;
}

/** Image URL part; OpenWebUI sends a `data:` URL for uploads (K10). */
export interface ChatImageUrlPart {
  readonly type: "image_url";
  readonly image_url: OpenAIImageURL;
}

/** `image_url` payload. A remote `url` is not fetched by the core (K10: size limits, SSRF). */
export interface OpenAIImageURL {
  /** `data:<mimeType>;base64,<data>` or `http(s)://…`. */
  readonly url: string;
  readonly detail?: "auto" | "low" | "high";
}

/** One message content part. */
export type ChatContentPart = ChatTextPart | ChatImageUrlPart;

/** Message content: the common string form, or parts for multimodal input. */
export type ChatContent = string | readonly ChatContentPart[];

/** One request message. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: ChatContent;
  /** Optional display name; ignored by the core. */
  readonly name?: string;
}

/**
 * `POST /v1/chat/completions` body — the subset OpenWebUI uses. Unknown fields must be ignored,
 * not rejected: OpenWebUI sends more (`max_tokens`, `top_p`, `stop`, `metadata`, …).
 */
export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** `true`: answer as SSE chunks; absent/`false`: one JSON response. */
  readonly stream?: boolean;
  /** K5: `include_usage` asks for a final usage-bearing chunk; honour it when it is cheap. */
  readonly stream_options?: { readonly include_usage?: boolean };
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_tokens?: number;
  readonly stop?: string | readonly string[];
  /** OpenAI's end-user id; advisory. Authorization is {@link RoleResolver}'s job, not this field. */
  readonly user?: string;
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

/** Token accounting in OpenAI's field names (K12: pi-ai's `Usage` maps onto these). */
export interface CompletionUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

/** K5: the finish reasons we can produce. `tool_calls` cannot happen in M1 (no tools). */
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

/** One choice of a complete answer. */
export interface CompletionChoice {
  readonly index: number;
  readonly message: { readonly role: "assistant"; readonly content: string };
  readonly finish_reason: FinishReason | null;
}

/** `chat.completion` — the non-streaming answer. */
export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: "chat.completion";
  /** Unix seconds. */
  readonly created: number;
  readonly model: string;
  readonly choices: readonly CompletionChoice[];
  readonly usage?: CompletionUsage;
}

// ---------------------------------------------------------------------------
// Streaming response (K5)
// ---------------------------------------------------------------------------

/**
 * One incremental choice. K5's sequence, which S2 must reproduce exactly:
 * 1. `delta: { role: "assistant" }`, `finish_reason: null`;
 * 2. one chunk per text delta: `delta: { content: "…" }`, `finish_reason: null`;
 * 3. `delta: {}` with the real `finish_reason` (and `usage` with `include_usage`);
 * 4. `data: [DONE]`.
 */
export interface ChunkChoice {
  readonly index: number;
  readonly delta: ChunkDelta;
  readonly finish_reason: FinishReason | null;
}

/** The `delta` object of a streamed chunk. */
export interface ChunkDelta {
  readonly role?: "assistant";
  readonly content?: string;
}

/** `chat.completion.chunk` — one SSE payload. */
export interface ChatCompletionChunk {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  /** Unix seconds. */
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChunkChoice[];
  readonly usage?: CompletionUsage;
}

/** Fields every chunk of one response shares; S2 creates it once per request. */
export interface CompletionBase {
  /** Response id, e.g. `chatcmpl-<uuid>`; also used for the whole stream. */
  readonly id: string;
  readonly created: number;
  readonly model: string;
}

// ---------------------------------------------------------------------------
// Model listing and errors
// ---------------------------------------------------------------------------

/** `GET /v1/models` entry. */
export interface OpenAIModel {
  readonly id: string;
  readonly object: "model";
  /** Unix seconds. */
  readonly created: number;
  readonly owned_by: string;
}

/** `GET /v1/models` response body: exactly one entry, {@link MODEL_ID}. */
export interface OpenAIModelList {
  readonly object: "list";
  readonly data: readonly OpenAIModel[];
}

/** OpenAI-shaped error body (401/404/500). */
export interface OpenAIErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly code: string | null;
  };
}

// ---------------------------------------------------------------------------
// Pure mappings (S2 implements)
// ---------------------------------------------------------------------------

/** Result of turning an OpenAI message list into pi-durable input. */
export interface MappedInput {
  /** Blocks ready for `Core.submitUserInput` (K10: `{type:"text"}` / `{type:"image",data,mimeType}`). */
  readonly input: UserInput;
  /** Plain text of the last user message: what M1 echo repeats and M2 shows in logs. */
  readonly text: string;
  /** Number of image parts carried over. */
  readonly images: number;
}

/** Options of {@link mapMessagesToInput}. */
export interface MapInputOptions {
  /**
   * K10: reject image data URLs whose decoded size exceeds this (bytes). Default: the vision
   * model's `inputLimits.images.resize.maxBytes` (4.5 MB in the Groq catalog).
   */
  readonly maxImageBytes?: number;
  /**
   * K10: `false` (default) rejects remote `http(s)` image URLs instead of fetching them; the core
   * must not become an SSRF proxy, and M2's `fitImage` works on bytes it already has.
   */
  readonly allowRemoteImages?: boolean;
}

/**
 * Maps the OpenAI `messages` array to pi-durable input (K10) and to the plain text of the last
 * user message. System messages are not part of the input: the role/date prompt is A1's section.
 * Unsupported parts (audio, files, `image_url` with a remote URL) are dropped and counted as
 * errors by the caller — throwing `UnsupportedPartError` is acceptable too, S2 decides.
 */
export function mapMessagesToInput(
  messages: readonly ChatMessage[],
  options?: MapInputOptions,
): MappedInput {
  throw new Error("Not implemented: contract only");
}

/** K5 step 1–2: a chunk carrying a role-only opening delta or one text delta. */
export function chunkFromDelta(base: CompletionBase, delta: ChunkDelta): ChatCompletionChunk {
  throw new Error("Not implemented: contract only");
}

/** K5 step 3: the final chunk — empty delta, real `finish_reason`, optional usage. */
export function finishChunk(
  base: CompletionBase,
  reason: FinishReason,
  usage?: CompletionUsage,
): ChatCompletionChunk {
  throw new Error("Not implemented: contract only");
}

/**
 * K5: pi-ai `stopReason` → OpenAI `finish_reason` (`stop → "stop"`, `length → "length"`,
 * `toolUse → "tool_calls"`, `aborted`/`error`/`pending` → `"stop"`). K5/abort: after an aborted
 * run the client has already received deltas and still needs a finish reason, so an aborted turn
 * is never an error chunk unless S2 decides otherwise.
 */
export function finishReasonFromTurn(
  turn: Pick<TurnResult, "status" | "stopReason">,
): FinishReason {
  throw new Error("Not implemented: contract only");
}
