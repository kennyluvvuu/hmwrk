/**
 * Module contract: the pi-durable facade (`Core`), implemented by S1 in `src/durable/**`.
 *
 * This file is types and signatures only — there is no logic to copy. Every non-obvious shape
 * below is pinned to a verified fact from `docs/research/pi-api-notes.md` (R1); the `K*` markers
 * point at the answer that justifies it. Consumers in W3:
 *
 * - S1 (`src/durable/harness.ts`, `src/durable/conversations.ts`) implements {@link openHarness}
 *   and {@link Core}.
 * - S2 (`src/server/**`) calls {@link Core.submitUserInput}, {@link Core.watchText},
 *   {@link Core.echo} and {@link Core.abort} from the OpenAI-compatible handler.
 * - A1 (`src/agent/**`) reads the role through {@link ActorDirectory} to render its prompt
 *   section; M2 tasks and tools arrive through the same `Core`.
 *
 * Rules the facade must keep (they are why the facade exists, ADR 0002 risk #1):
 * - One SQLite file for durable and domain tables, one `SqliteDatabase` for both (K2).
 * - `identity.attribution` names this app, but does not change Groq/Mistral requests (K1).
 * - «User → conversation» is our own mapping document, written in the same commit as the
 *   conversation (K3): durable has no such index.
 * - `wait()` is the authoritative result; text deltas are a live-view illusion (K4/K5).
 */

import type { Context } from "@earendil-works/chord/context";
import type { Models, StopReason, Usage } from "@earendil-works/pi-ai";
import type { ClientAttribution, ClientIdentity } from "@earendil-works/pi-ai/utils/identity";
import type {
  Conversation,
  ConversationId,
  ConversationRetryPolicy,
  EntryId,
  Extension,
  Harness,
  HarnessSettings,
  ProgressPolicy,
  Report,
  SetTimer,
  Submission,
  UserInput,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { Logger, ModelsConfig } from "../config/index.js";
import type { Role } from "../domain/index.js";

// ---------------------------------------------------------------------------
// Fixed values shared by S1, S2 and A1
// ---------------------------------------------------------------------------

/** Table/index prefix of the durable schema in the shared SQLite file (K2). Host tables stay unprefixed. */
export const PI_SCHEMA_PREFIX = "pi_";

/** App name used for provider attribution (K1). Overridable through {@link OpenHarnessOptions.identity}. */
export const APP_NAME = "hmwrk";

/**
 * K1: `identity.attribution` merged over `DEFAULT_HARNESS_IDENTITY`, which otherwise claims to be
 * pi. Groq and Mistral ignore attribution headers, so this is a project rule, not a behaviour
 * change (R1 observation #10).
 */
export const APP_ATTRIBUTION: ClientAttribution = {
  name: APP_NAME,
  url: "https://github.com/hmwrk/hmwrk",
};

/**
 * K3: kind of the session document mapping our users to durable conversations. It must not start
 * with `pi.` (reserved) and it is written in the same commit that creates the conversation.
 */
export const USER_CONVERSATIONS_DOC_KIND = "app.user-conversations";

// ---------------------------------------------------------------------------
// Opening and closing the core
// ---------------------------------------------------------------------------

/**
 * The subset of `Config` (src/config) `openHarness` needs. `Config` satisfies it structurally, so
 * callers pass their loaded config directly; the narrow shape keeps this contract testable.
 */
export interface HarnessConfig {
  /** SQLite file shared by durable and domain tables (K2). `Config.dbPath` today. */
  readonly dbPath: string;
  /** Data directory; photos and other files live here, never in SQLite (SPEC §5.2). */
  readonly dataDir: string;
  /** Per-slot model ids from `models.json` (SPEC §7, K8). Never hardcode provider/model ids. */
  readonly models: ModelsConfig;
}

/**
 * K2: how durable tables get their SQLite file. `shared-file` is the R1 verdict (one file, one
 * `SqliteDatabase`). `separate-file` exists only as an escape hatch if the shared file turns out
 * to be a problem — it costs a second connection and loses atomicity with domain writes.
 */
export type StorageLayout =
  | { readonly kind: "shared-file" }
  | { readonly kind: "separate-file"; readonly durableDbPath: string };

/**
 * Partial `HarnessOptions.settings`. pi-durable merges object fields over its built-in defaults
 * and reads the value at every use, so S1 passes a getter, not a frozen object (K1).
 */
export interface HarnessSettingsOverrides {
  /**
   * K5: partial-commit cadence for streamed answers. Default `partialIntervalMs: 100`; R1
   * recommends 30–50 for a smooth SSE stream (`persistWithinMs` defaults to 1000).
   */
  readonly progress?: Partial<ProgressPolicy>;
  /** K1: retry policy for failed model requests. */
  readonly retry?: Partial<ConversationRetryPolicy>;
  /** K1/K11: consecutive crash cut-offs before a task ends instead of rerunning. Default 5. */
  readonly restartLimit?: number;
  /** K4: what queued inputs do after a failed run. Default `keep`. */
  readonly afterFailedRun?: HarnessSettings["afterFailedRun"];
}

/** Options of {@link openHarness}; each maps to one `HarnessOptions` field listed in K1. */
export interface OpenHarnessOptions {
  /** Default: one shared SQLite file (K2). */
  readonly storage?: StorageLayout;
  /**
   * Extensions installed into the registry before opening (K7): A1's `hmwrk` section, M2's tools.
   * Absent: only pi-durable's built-in tasks are registered.
   */
  readonly extensions?: readonly Extension[];
  /** Default: {@link APP_ATTRIBUTION} (K1). */
  readonly identity?: ClientIdentity;
  /** Settings overrides; read at every use (K1). */
  readonly settings?: HarnessSettingsOverrides;
  /** K1: failures that do not fail the caller — route to the T2 logger. */
  readonly onReport?: (report: Report) => void;
  /** K9/K11: host clock, epoch ms. Every process over the same storage must use the same clock. */
  readonly now?: () => number;
  /** K9: timer source. Only tests (fake clock) should pass it. */
  readonly setTimer?: SetTimer;
  /**
   * Test seam (S1): an already built `Models` collection, e.g. one holding the pi-ai faux provider (K6/R1).
   * Production passes nothing and gets the groq/mistral catalogue of {@link openHarness} (K8).
   */
  readonly models?: Models;
  /** T2 logger for the facade's own diagnostics (missing model slots, reports). Default: a `durable` child. */
  readonly logger?: Logger;
  /** Invocation context for `Harness.open`; default `BACKGROUND_CONTEXT` (K1). */
  readonly context?: Context;
  /** K2: SQLite busy timeout in ms; the adapter default is 5000. */
  readonly busyTimeoutMs?: number;
}

/**
 * Open the durable core over SQLite (K1/K2): builds `Models` from the groq/mistral provider
 * factories (K8), creates the registry, installs `options.extensions`, then `Harness.open`.
 *
 * Does **not** call `resume()`; boot code decides when scheduling starts (K9), and
 * `readOnly` is intentionally not exposed (K11).
 */
export async function openHarness(cfg: HarnessConfig, options?: OpenHarnessOptions): Promise<Core> {
  // S1's implementation lives in `src/durable/harness.ts`, the only module allowed to call pi-durable
  // (ADR 0002 risk #1). It is loaded lazily for two reasons: this contract module stays importable without
  // pi-durable/storage for S2 and A1, and the durable module can import the fixed values above without a
  // module cycle.
  const { openHarnessCore } = await import("../durable/harness.js");
  return openHarnessCore(cfg, options);
}

/** The open core: the only object the server, the agent and durable tasks hold. */
export interface Core {
  /** Escape hatch to the pi-durable API; prefer the methods below. */
  readonly harness: Harness;
  /** The shared SQLite connection — domain repos (D2) query through the same object (K2). */
  readonly db: SqliteDatabase;
  /** Durable storage over {@link Core.db}; kept open for storage-specific operations and tests. */
  readonly storage: SqliteStorage;
  /** K3: our user→conversation index, for the agent prompt (A1) and follow-ups. */
  readonly actors: ActorDirectory;

  /**
   * K9/K1: enable scheduling and recover interrupted work. Idempotent; call once on boot and
   * after a restart. Wraps the synchronous `Harness.resume()` in a promise for the boot sequence.
   */
  resume(): Promise<void>;

  /**
   * K11: seal admission, settle admitted commits, wait for running task code, close storage.
   * Boot code calls it from `SIGTERM`/`SIGINT` with a hard-exit safety timer.
   */
  close(): Promise<void>;

  /**
   * K3: the durable conversation of `userId`, created on first use. Creation, the model
   * `configure()` (K3 gotcha: a conversation created without a model fails `no_model`) and the
   * mapping-document write happen in one commit. The only way user conversations are created.
   */
  getOrCreateConversation(userId: string, role: Role): Promise<CoreConversation>;

  /** K3: mapping lookup only; `null` when this user has no conversation yet. */
  conversation(userId: string): Promise<CoreConversation | null>;

  /**
   * K4: durable idempotent admission of user input. `input` is pi-durable's `UserInput`, i.e. a
   * plain string or text/image blocks (K10). Returns as soon as the input is admitted.
   */
  submitUserInput(
    conversation: CoreConversation,
    input: UserInput,
    options?: SubmitUserInputOptions,
  ): Promise<PendingTurn>;

  /**
   * K5: observe the answer being generated in `conversation` and receive **text deltas**, i.e.
   * the growth of `docs["pi.live"].generation.message` since the previous notification. Attach
   * before submitting to see the first token. Not the authoritative text: read
   * {@link PendingTurn.settle} for the final one.
   */
  watchText(
    conversation: CoreConversation,
    listener: TextDeltaListener,
    options?: WatchTextOptions,
  ): Promise<TextStream>;

  /**
   * K6 (M1): echo without a model — two entries (`pi.user`, `pi.assistant`) in one commit. No
   * task, no submission, therefore no `requestId` idempotency (an OpenWebUI retry duplicates the
   * pair; harmless in M1, fixed once M2 moves requests to {@link submitUserInput}).
   */
  echo(conversation: CoreConversation, text: string, options?: EchoOptions): Promise<EchoTurn>;

  /**
   * K4/K5: stop generation in this conversation (and withdraw its queued inputs). The partial
   * answer stays in the transcript with `stopReason: "aborted"`; the client still needs a
   * `finish_reason`, which S2 takes from {@link TurnResult}.
   */
  abort(conversation: CoreConversation, context?: Context): Promise<void>;
}

/** One durable conversation owned by an application user (K3). */
export interface CoreConversation {
  /** Durable conversation id; branded number, not a string (K3). */
  readonly id: ConversationId;
  /** Our stable actor id (the key of the mapping document). */
  readonly userId: string;
  /** Role at the time the conversation was opened; the prompt section re-reads the directory. */
  readonly role: Role;
  /** pi-durable handle for calls this facade does not wrap (entries, context, tasks). */
  readonly handle: Conversation;
}

// ---------------------------------------------------------------------------
// K3: the user ↔ conversation mapping
// ---------------------------------------------------------------------------

/** An application user as the core knows it (SPEC §4). */
export interface ActorRecord {
  readonly userId: string;
  readonly role: Role;
}

/**
 * K3: the mapping durable lacks. S1 owns the storage (a `defineDoc` session document with kind
 * {@link USER_CONVERSATIONS_DOC_KIND}, recommended by R1, or a host table in the same file).
 *
 * Shape S1 persists (documented here because A1 and S2 both depend on it):
 *
 * ```ts
 * interface UserConversationIndex {
 *   byUser: Record<string, number>;      // userId → ConversationId (number, K3)
 *   actors: Record<string, ActorRecord>; // String(ConversationId) → actor; reverse lookup for the prompt
 * }
 * ```
 *
 * `byUser` is the R1 shape; `actors` is the reverse direction A1's section needs, because
 * `PromptInput` carries a `conversationId` and nothing else about the person.
 */
export interface UserConversationIndex {
  /**
   * `userId` → conversation id as a **plain number**: the document is JSON and `ConversationId`
   * is a branded number (K3), so S1 casts on read (`known as ConversationId`) and stores the
   * number as is. Writing it as a string would not match `harness.conversation(id)`.
   */
  readonly byUser: Readonly<Record<string, number>>;
  /** `String(conversationId)` → actor; reverse lookup for the prompt section (A1). */
  readonly actors: Readonly<Record<string, ActorRecord>>;
}

/** Read side of the mapping: what A1's prompt section and S2's follow-up paths call. */
export interface ActorDirectory {
  /** Role and id of the person who owns `conversationId`, or `null` for an unknown conversation. */
  get(conversationId: ConversationId): Promise<ActorRecord | null>;
}

// ---------------------------------------------------------------------------
// K4/K5: one submitted turn
// ---------------------------------------------------------------------------

/** Options of {@link Core.submitUserInput}. */
export interface SubmitUserInputOptions {
  /**
   * K4: idempotency key, scoped to the conversation. Resubmitting the same value returns the same
   * submission and starts no second run. S2 should pass a value derived from the SSE request so
   * OpenWebUI retries are free.
   */
  readonly requestId?: string;
  /**
   * K4: what a busy conversation does with the input. Default `followUp` (queues in
   * `pi.inbox`); `reject` throws `ConversationBusy` instead of queueing.
   */
  readonly whenBusy?: "steer" | "followUp" | "reject";
  /** Invocation context; abort it to cancel only the awaiting call, not the run (K4). */
  readonly context?: Context;
}

/** A durably admitted turn: settle for the answer, abort to stop it early (K4). */
export interface PendingTurn {
  /** The pi-durable submission (K4); `id` is its durable id. */
  readonly submission: Submission;
  /** The request id actually used, generated by S1 when the caller passed none (K4). */
  readonly requestId: string;

  /**
   * K4: the authoritative outcome. `status: "done"` carries the final assistant text extracted
   * from `settled.answer` (R1's snippet, including the `answer === undefined` guard — the type is
   * an intersection, `status === "done"` does **not** narrow it). `unanswered` carries why.
   *
   * Rejects when `context` is aborted (client disconnect); the run itself continues, so S1 keeps
   * the extraction available to a later `harness.submission(id)`.
   */
  settle(context?: Context): Promise<TurnResult>;

  /** K4: withdraw the queued input, or stop the run. Result is pi-durable's abort outcome. */
  abort(context?: Context): Promise<TurnAbortOutcome>;
}

/** K4: pi-durable's `Submission.abort()` outcome. */
export type TurnAbortOutcome = "aborted" | "already_placed" | "settled";

/** K4: a turn either produced an answer entry or not. */
export type TurnStatus = "done" | "unanswered";

/** K4: why a turn produced no answer. Values seen in 1.6.0; `reason` stays open for new ones. */
export interface TurnFailure {
  /** `aborted` | `reset` | `model_error` | `no_model` | `turn_limit` | `run_failed` | `stale` (K4). */
  readonly reason: string;
  /** Free-form diagnostic, e.g. the provider error text. */
  readonly detail?: unknown;
}

/** K4: the flattened result S2 answers an HTTP request with. */
export interface TurnResult {
  readonly status: TurnStatus;
  /** Final assistant text (K4 extraction). `""` when there is no answer. */
  readonly text: string;
  /** K4: the `pi.assistant` entry id the text came from; absent when `unanswered`. */
  readonly answerEntryId?: EntryId;
  /**
   * K4/K5: pi-ai stop reason of that answer (`stop`, `length`, `toolUse`, `aborted`, `error`, …).
   * S2 maps it to OpenAI's `finish_reason` — see `finishReasonFromTurn` in `./openai.ts`.
   */
  readonly stopReason?: StopReason;
  /** Present when `status === "unanswered"`. */
  readonly failure?: TurnFailure;
  /** K12: usage of the answering message, straight from the entry. */
  readonly usage?: Usage;
}

// ---------------------------------------------------------------------------
// K5: text deltas while the answer is generated
// ---------------------------------------------------------------------------

/** Receives one increment of the answer text. Async listeners are awaited in order (K5). */
export type TextDeltaListener = (delta: string) => void | Promise<void>;

/** Handle of an attached text watch; `stop()` detaches without touching the run (K5). */
export interface TextStream {
  stop(): Promise<void>;
}

/** Options of {@link Core.watchText}. */
export interface WatchTextOptions {
  /** Attachment context; aborting it ends the watch, not the run (K4/K5). */
  readonly context?: Context;
  /**
   * K5: deliver the text already present at attach time as one first delta. Default `true`,
   * because S2 attaches after `submit()` and the model may have started.
   */
  readonly replay?: boolean;
}

// ---------------------------------------------------------------------------
// K6: echo mode for M1
// ---------------------------------------------------------------------------

/** Options of {@link Core.echo}. */
export interface EchoOptions {
  /** Stored for a future dedupe table; M1 does not deduplicate (K6). */
  readonly requestId?: string;
}

/** K6: what the direct-entry echo wrote. */
export interface EchoTurn {
  readonly conversationId: ConversationId;
  readonly userEntryId: EntryId;
  readonly assistantEntryId: EntryId;
  /** The echoed text (the prompt), so the caller need not read the transcript back. */
  readonly text: string;
}
