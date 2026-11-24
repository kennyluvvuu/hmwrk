/**
 * Hono application of the OpenAI-compatible server (S2): `POST /v1/chat/completions`,
 * `GET /v1/models`, `GET /healthz`, Bearer authentication (SPEC §3, §4, §6).
 *
 * The route owns framing, auth, the conversation, idempotency and photo intake; the agent itself
 * lives behind {@link TurnRunner}. Boot passes {@link import("./turn.js").generationTurnRunner}
 * (M2: `submitUserInput` + `watchText` + `settle`), while `HMWRK_ECHO=1` keeps the M1 echo runner
 * for `scripts/verify-m1.sh` and for a key-less smoke run.
 */
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
import { attachMessagePhotos, lastUserContent, photoAttachmentBlock, type PhotoSink } from "./images.js";
import { SSE_HEADERS, sseBody, type SseEmit } from "./sse.js";

// ---------------------------------------------------------------------------
// The slice of the durable core the server calls
// ---------------------------------------------------------------------------

/**
 * Port of {@link Core} the HTTP layer needs. `Core` satisfies it structurally, and keeping the
 * port narrow is what lets tests run against `testing/fake-core.ts` without a harness. The M2
 * generation path (`submitUserInput`/`watchText`/`abort`) is typed on its own as
 * {@link import("./turn.js").GenerationCore}, so the echo-only fake core stays valid.
 */
export type ServerCore = Pick<Core, "getOrCreateConversation" | "echo"> &
  /**
   * I3: read-only, used to salt the fallback `requestId` with the conversation's committed state.
   * Optional so the echo-only fakes of the route tests stay valid; without it the fallback is the
   * pre-I3 hash.
   */
  Partial<Pick<Core, "harness">>;

// ---------------------------------------------------------------------------
// One turn, whichever mechanism produces it
// ---------------------------------------------------------------------------

/** Everything a runner needs to answer one HTTP request. */
export interface TurnRequest {
  readonly conversation: CoreConversation;
  readonly input: MappedInput;
  /** Stable per HTTP request; the generation runner passes it as `requestId` (K4 idempotency). */
  readonly requestId: string;
  /** Live text sink for the SSE path; absent for the non-streaming answer. */
  readonly onTextDelta?: (delta: string) => void;
  /** Aborted when the client disconnects; the runner stops the run and keeps the partial answer. */
  readonly signal?: AbortSignal;
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
  /** The agent behind the endpoint. Default: the M1 echo (kept for `HMWRK_ECHO=1` and tests). */
  readonly turnRunner?: TurnRunner;
  /**
   * Photo store of `data:` images attached to the message (D2's `PhotoFiles`). Absent: image parts
   * are counted but dropped, which is what the echo path and the route tests do.
   */
  readonly photoIntake?: PhotoSink;
}

/** Header carrying a client-chosen idempotency key (`X-Request-Id`). */
export const REQUEST_ID_HEADER = "x-request-id";

function errorBody(message: string, type: string, code: string | null) {
  return { error: { message, type, code } };
}

/**
 * K4: the durable idempotency key of one HTTP request.
 *
 * `X-Request-Id` wins when the client sends one. Otherwise the key is a hash of what the answer
 * depends on — the actor, the model, the messages and (I3) the conversation's committed state — so
 * an OpenWebUI retry of the very same request lands on the same submission and produces no second
 * pair of entries.
 *
 * The state salt closes the I2 trade-off (W5–W6 finding): without it two genuinely identical user
 * messages in a row collapsed into one run, and the second real question got the first answer back.
 * With the conversation's newest entry id in the hash, a retry in the *same* state is still the same
 * request, while the same words after new events (the previous answer, a check-in, a verdict) are a
 * new turn. `state` is `""` when the caller cannot read it — then this is the pre-I3 behaviour.
 */
export function deriveRequestId(
  headerValue: string | undefined,
  actor: ResolvedActor,
  request: ChatCompletionRequest,
  state = "",
): string {
  const fromHeader = headerValue?.trim();
  if (fromHeader !== undefined && fromHeader !== "") return fromHeader;
  const hash = createHash("sha256")
    .update(actor.userId)
    .update("\u0000")
    .update(MODEL_ID)
    .update("\u0000")
    .update(JSON.stringify(request.messages));
  if (state !== "") hash.update("\u0000").update(state);
  return `auto-${hash.digest("hex").slice(0, 40)}`;
}

/**
 * SPEC §4 risk #3 instrumentation: which `X-OpenWebUI-*` headers arrived, **names only**.
 *
 * Values carry the account identity and are never logged. At `LOG_LEVEL=debug` this is what the
 * manual OpenWebUI checkpoint reads back to confirm what the current OpenWebUI version sends.
 */
/**
 * I3: the conversation's committed state, as its newest entry id — a monotone counter over the
 * transcript, read in a write-free commit (the same trick the notify scheduler uses to find a live
 * task). An empty string means «unknown», which leaves the fallback hash as it was in M2.
 */
async function conversationState(
  core: ServerCore,
  conversation: CoreConversation,
  logger: Logger | undefined,
): Promise<string> {
  if (core.harness === undefined) return "";
  try {
    const latest = await core.harness.commit((tx) => tx.latestEntryId(conversation.id), BACKGROUND_CONTEXT);
    return latest === undefined ? "empty" : String(latest);
  } catch (error) {
    // A state read must never cost the user an answer; idempotency degrades to the I2 hash.
    logger?.warn("could not read the conversation state for the request id", { error });
    return "";
  }
}

function openWebUiHeaderNames(headers: Headers): string[] {
  const names: string[] = [];
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith("x-openwebui-")) names.push(name.toLowerCase());
  });
  return names.sort();
}

function authErrorBody(error: AuthError) {
  return errorBody(error.message, "invalid_request_error", error.code);
}

/** Unix seconds for OpenAI `created` fields. */
function unixSeconds(now: () => number): number {
  return Math.floor(now() / 1000);
}

/** Parse + map, so both failures render as one 400 instead of two nested try blocks. */
type ParsedRequest = { request: ChatCompletionRequest; mapped: MappedInput };

function parseRequest(raw: unknown): ParsedRequest {
  const request = parseChatCompletionRequest(raw);
  return { request, mapped: mapMessagesToInput(request.messages) };
}

/**
 * Builds the Hono app. No `listen` here: tests drive it with `app.request()`, and the process
 * boot (`src/index.ts`) hands it to `serve()`.
 */
export function createApp(options: AppOptions): Hono<AppEnv> {
  const { core, resolver, logger, photoIntake } = options;
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
    if (logger !== undefined && logger.level === "debug") {
      // Names only: the values are OpenWebUI account identifiers (see openWebUiHeaderNames).
      logger.debug("request identity", {
        via: result.actor.via,
        role: result.actor.role,
        openwebuiHeaders: openWebUiHeaderNames(c.req.raw.headers),
      });
    }
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

    let parsed: ParsedRequest;
    try {
      parsed = parseRequest(raw);
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return c.json(errorBody(error.message, "invalid_request_error", error.code), 400);
      }
      throw error;
    }
    const { request, mapped } = parsed;

    // Attached photos become stored photo ids the agent passes to `submit_check_in` (SPEC §5.4).
    // A broken image is a warning, never a failed message.
    const attachments =
      photoIntake === undefined || mapped.images === 0
        ? { ids: [] as string[], problems: [] as string[] }
        : await attachMessagePhotos(lastUserContent(request.messages) ?? "", {
            sink: photoIntake,
            // SPEC §5.3: a parent's screenshot is intake material, a child's photo is a check-in.
            role: actor.role,
          });
    for (const problem of attachments.problems) logger?.warn("dropped an attached image", { problem });

    const text =
      attachments.ids.length === 0
        ? mapped.text
        : `${mapped.text}\n\n${photoAttachmentBlock(attachments.ids, actor.role)}`;

    if (text.trim() === "") {
      return c.json(
        errorBody("The last user message has no text content", "invalid_request_error", "empty_message"),
        400,
      );
    }

    // One durable conversation per actor (K3); the role travels with it for the prompt (A1).
    const conversation = await core.getOrCreateConversation(actor.userId, actor.role);
    const requestId = deriveRequestId(
      c.req.header(REQUEST_ID_HEADER),
      actor,
      request,
      await conversationState(core, conversation, logger),
    );
    const turnInput: MappedInput = { input: text, text, images: mapped.images };
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
      photos: attachments.ids.length,
      requestId,
    });

    if (request.stream === true) {
      // K5: the run is aborted when the SSE reader goes away (client closed the tab).
      const disconnect = new AbortController();
      return c.body(
        sseBody(
          async (emit: SseEmit) => {
            // K5 step 1: the opening role delta.
            emit(chunkFromDelta(base, { role: "assistant" }));
            const outcome = await runTurn({
              conversation,
              input: turnInput,
              requestId,
              signal: disconnect.signal,
              onTextDelta: (delta) => emit(chunkFromDelta(base, { content: delta })),
            });
            // K5 step 3: empty delta + finish_reason (+ usage, which OpenWebUI ignores).
            emit(finishChunk(base, outcome.finishReason, outcome.usage ?? ZERO_USAGE));
          },
          { onCancel: () => disconnect.abort() },
        ),
        200,
        SSE_HEADERS,
      );
    }

    const outcome = await runTurn({ conversation, input: turnInput, requestId });
    return c.json(
      chatCompletionResponse(base, outcome.text, outcome.usage ?? ZERO_USAGE, outcome.finishReason),
    );
  });

  app.notFound((c) => c.json(errorBody(`Not found: ${c.req.method} ${c.req.path}`, "invalid_request_error", null), 404));

  app.onError((error, c) => {
    logger?.error("unhandled server error", { error, path: c.req.path });
    return c.json(errorBody("Internal server error", "server_error", null), 500);
  });

  return app;
}
