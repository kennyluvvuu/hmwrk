/**
 * Hono application of the OpenAI-compatible server (S2): `POST /v1/chat/completions`,
 * `GET /v1/models`, `GET /healthz`, Bearer authentication (SPEC §3, §4, §6).
 *
 * M1 behaviour: the durable core answers with an echo turn (R1 K6, two entries in one commit);
 * the text is then either returned as one `chat.completion` or replayed as the K5 SSE sequence.
 * M2 replaces only {@link TurnRunner}: `submitUserInput` + `watchText` feed the same `onTextDelta`
 * sink, so framing, headers and the conversation plumbing stay as they are.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Core, CoreConversation, EchoOptions } from "../contracts/harness.js";
import {
  MODEL_ID,
  MODEL_OWNER,
  type ChatCompletionRequest,
  type CompletionBase,
  type CompletionUsage,
  type FinishReason,
  type MappedInput,
  type OpenAIModelList,
} from "../contracts/openai.js";
import type { AuthError, ResolvedActor, RoleResolver } from "../contracts/roles.js";
import type { Logger } from "../config/index.js";
import {
  InvalidRequestError,
  ZERO_USAGE,
  chatCompletionResponse,
  chunkFromDelta,
  finishChunk,
  mapMessagesToInput,
  parseChatCompletionRequest,
  splitText,
} from "./openai-mappers.js";
import { SSE_HEADERS, sseBody, type SseEmit } from "./sse.js";

// ---------------------------------------------------------------------------
// The slice of the durable core the server calls
// ---------------------------------------------------------------------------

/**
 * Port of {@link Core} the HTTP layer needs today. `Core` satisfies it structurally, and keeping
 * the port narrow is what lets tests run against `testing/fake-core.ts` without a harness.
 *
 * M2 (I2) widens this with `submitUserInput` / `watchText` / `abort`.
 */
export type ServerCore = Pick<Core, "getOrCreateConversation" | "echo">;

// ---------------------------------------------------------------------------
// One turn, whichever mechanism produces it
// ---------------------------------------------------------------------------

/** Everything a runner needs to answer one HTTP request. */
export interface TurnRequest {
  readonly conversation: CoreConversation;
  readonly input: MappedInput;
  /** Stable per HTTP request; M2 passes it as `requestId` for durable idempotency (K4). */
  readonly requestId: string;
  /** Live text sink for the SSE path; absent for the non-streaming answer. */
  readonly onTextDelta?: (delta: string) => void;
}

/** The finished turn, in OpenAI terms. */
export interface TurnOutcome {
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly usage?: CompletionUsage;
}

/**
 * DI seam for M2: today {@link echoTurnRunner}, later a runner built on `submitUserInput` +
 * `watchText` whose `onTextDelta` fires while the model generates.
 */
export type TurnRunner = (request: TurnRequest) => Promise<TurnOutcome>;

/** M1 (R1 K6): echo through the core — no model, no submission, no tokens. */
export function echoTurnRunner(core: Pick<Core, "echo">, options: { deltaChars?: number } = {}): TurnRunner {
  return async ({ conversation, input, requestId, onTextDelta }: TurnRequest): Promise<TurnOutcome> => {
    const echoOptions: EchoOptions = { requestId };
    const turn = await core.echo(conversation, input.text, echoOptions);
    if (onTextDelta !== undefined) {
      for (const delta of splitText(turn.text, options.deltaChars)) onTextDelta(delta);
    }
    return { text: turn.text, finishReason: "stop", usage: ZERO_USAGE };
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type AppEnv = { Variables: { actor: ResolvedActor } };

export interface AppOptions {
  readonly core: ServerCore;
  readonly resolver: RoleResolver;
  readonly logger?: Logger;
  /** Clock for `created` fields; tests pin it. */
  readonly now?: () => number;
  /** Overrides the M1 echo runner (M2 seam). */
  readonly turnRunner?: TurnRunner;
}

function errorBody(message: string, type: string, code: string | null) {
  return { error: { message, type, code } };
}

function authErrorBody(error: AuthError) {
  return errorBody(error.message, "invalid_request_error", error.code);
}

/** Unix seconds for OpenAI `created` fields. */
function unixSeconds(now: () => number): number {
  return Math.floor(now() / 1000);
}

/** Parse + map, so both failures render as one 400 instead of two nested try blocks. */
function parseRequest(raw: unknown): { request: ChatCompletionRequest; mapped: MappedInput } {
  const request = parseChatCompletionRequest(raw);
  return { request, mapped: mapMessagesToInput(request.messages) };
}

/**
 * Builds the Hono app. No `listen` here: tests drive it with `app.request()`, and the process
 * boot (`src/index.ts`) hands it to `serve()`.
 */
export function createApp(options: AppOptions): Hono<AppEnv> {
  const { core, resolver, logger } = options;
  const now = options.now ?? (() => Date.now());
  const runTurn = options.turnRunner ?? echoTurnRunner(core);

  const app = new Hono<AppEnv>();

  // Liveness probe for compose; never authenticated, never touches the core.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Everything under /v1 requires a resolved actor (401 with an OpenAI-shaped body otherwise).
  app.use("/v1/*", async (c, next) => {
    const result = await resolver.authorize({ get: (name) => c.req.header(name) });
    if (!result.ok) {
      logger?.warn("request rejected", { code: result.error.code, path: c.req.path });
      return c.json(authErrorBody(result.error), result.error.httpStatus);
    }
    c.set("actor", result.actor);
    await next();
  });

  app.get("/v1/models", (c) => {
    const body: OpenAIModelList = {
      object: "list",
      data: [{ id: MODEL_ID, object: "model", created: unixSeconds(now), owned_by: MODEL_OWNER }],
    };
    return c.json(body);
  });

  app.post("/v1/chat/completions", async (c) => {
    const actor = c.get("actor");

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(errorBody("Request body must be valid JSON", "invalid_request_error", "invalid_json"), 400);
    }

    let parsed: { request: ChatCompletionRequest; mapped: MappedInput };
    try {
      parsed = parseRequest(raw);
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return c.json(errorBody(error.message, "invalid_request_error", error.code), 400);
      }
      throw error;
    }
    const { request, mapped } = parsed;

    if (mapped.text.trim() === "") {
      return c.json(
        errorBody("The last user message has no text content", "invalid_request_error", "empty_message"),
        400,
      );
    }

    // One durable conversation per actor (K3); the role travels with it for the prompt (A1).
    const conversation = await core.getOrCreateConversation(actor.userId, actor.role);
    const base: CompletionBase = {
      id: `chatcmpl-${randomUUID()}`,
      created: unixSeconds(now),
      model: MODEL_ID,
    };
    logger?.debug("chat completion", {
      userId: actor.userId,
      role: actor.role,
      conversationId: conversation.id,
      stream: request.stream === true,
      images: mapped.images,
    });

    if (request.stream === true) {
      return c.body(
        sseBody(async (emit: SseEmit) => {
          // K5 step 1: the opening role delta.
          emit(chunkFromDelta(base, { role: "assistant" }));
          const outcome = await runTurn({
            conversation,
            input: mapped,
            requestId: base.id,
            onTextDelta: (delta) => emit(chunkFromDelta(base, { content: delta })),
          });
          // K5 step 3: empty delta + finish_reason (+ usage, which OpenWebUI ignores).
          emit(finishChunk(base, outcome.finishReason, outcome.usage ?? ZERO_USAGE));
        }),
        200,
        SSE_HEADERS,
      );
    }

    const outcome = await runTurn({ conversation, input: mapped, requestId: base.id });
    return c.json(chatCompletionResponse(base, outcome.text, outcome.usage ?? ZERO_USAGE));
  });

  app.notFound((c) => c.json(errorBody(`Not found: ${c.req.method} ${c.req.path}`, "invalid_request_error", null), 404));

  app.onError((error, c) => {
    logger?.error("unhandled server error", { error, path: c.req.path });
    return c.json(errorBody("Internal server error", "server_error", null), 500);
  });

  return app;
}
