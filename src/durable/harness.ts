/**
 * The facade: the only module in the project that opens pi-durable (ADR 0002 risk #1).
 *
 * Everything a caller needs is in `src/contracts/harness.ts` (`Core`, `openHarness`); this file supplies
 * the implementation, and nothing outside `src/durable/**` may import pi-durable directly.
 *
 * Opening, in the order that matters:
 * 1. one `SqliteDatabase` for the whole file (K2 verdict: no second file, no second connection — domain
 *    tables will live on this same object in W5),
 * 2. `SqliteStorage.open(db, { prefix: "pi_" })` — durable tables and indexes are prefixed, host tables are not,
 * 3. `Models` from the groq/mistral factories (K8) — a missing API key is not fatal in M1: no model call
 *    happens until M2, and `models.getAvailable()` is the health check for when it does,
 * 4. the registry, with whatever extensions the host installs (`installExtensions()`, A1/M2),
 * 5. `Harness.open`, with the hmwrk attribution (K1), settings behind a getter (read at every use) and the
 *    T2 logger as the report sink,
 * 6. `Core.resume()` on boot, which stays the caller's decision (K9/K11): open recovers, resume schedules.
 *
 * `readOnly` is deliberately absent (K11): a read-only harness needs a read-write SQLite connection anyway
 * and we have exactly one writer.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import {
  Harness,
  createRegistry,
  type Extension,
  type HarnessSettings,
  type Registry,
  type Report,
  type UserInput,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { MODEL_SLOTS } from "../config/index.js";
import { createLogger, type Logger } from "../config/logger.js";
import {
  APP_ATTRIBUTION,
  PI_SCHEMA_PREFIX,
  type Core,
  type CoreConversation,
  type EchoOptions,
  type EchoTurn,
  type HarnessConfig,
  type OpenHarnessOptions,
  type PendingTurn,
  type StorageLayout,
  type SubmitUserInputOptions,
  type TextDeltaListener,
  type TextStream,
  type WatchTextOptions,
} from "../contracts/harness.js";
import type { Role } from "../domain/index.js";
import {
  conversationByUser,
  conversationModelRef,
  createActorDirectory,
  getOrCreateConversation,
  type ConversationDeps,
} from "./conversations.js";
import {
  abortConversation,
  echoTurn,
  submitUserInput as submitTurn,
  watchText as watchConversationText,
} from "./submit.js";

/**
 * K5/R1 observation #7: partial-answer commits every 40 ms — smooth enough for OpenWebUI's SSE and still
 * four times cheaper than writing every token. `progress.persistWithinMs` keeps its default (1 s).
 */
export const DEFAULT_PARTIAL_INTERVAL_MS = 40;

/** K1: retries of a failed model request; pi-durable's own default is 3, pinned here so the facade owns it. */
export const DEFAULT_MAX_RETRIES = 3;

const DEFAULT_LOGGER: Logger = createLogger({ bindings: { module: "durable" } });

/** Registries of open cores: `Core` (the contract) does not expose the registry, extensions still need it. */
const registries = new WeakMap<Core, Registry>();

// ---------------------------------------------------------------------------
// Models (K8)
// ---------------------------------------------------------------------------

/**
 * K8: the model catalogue of the two providers SPEC §7 uses. Provider ids, not model ids, live here; the
 * concrete ids come from `models.json` through `Config`.
 */
export function buildModels(): Models {
  const models = createModels({ identity: { attribution: APP_ATTRIBUTION } });
  models.setProvider(groqProvider());
  models.setProvider(mistralProvider());
  return models;
}

/**
 * Boot-time config check, not a failure: M1 never calls a model, and W5's health check is
 * `models.getAvailable()` (empty without API keys). A typo in models.json is worth one warning line.
 */
function warnAboutMissingModels(models: Models, cfg: HarnessConfig, logger: Logger): void {
  const missing = MODEL_SLOTS.map((slot) => ({ slot, ...cfg.models[slot] })).filter(
    (ref) => models.getModel(ref.provider, ref.modelId) === undefined,
  );
  if (missing.length > 0) {
    logger.warn("model slots are not in the pi-ai catalogue", { missing });
  }
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

function resolveDatabasePath(cfg: HarnessConfig, layout: StorageLayout | undefined): string {
  if (layout?.kind === "separate-file") return layout.durableDbPath;
  return cfg.dbPath;
}

/**
 * `Config` documents that the caller creates the data directory. The facade is defensive only about the
 * parent of the SQLite file it was handed, because a missing directory fails the very first boot with a
 * confusing `SQLITE_CANTOPEN`.
 */
function ensureParentDirectory(path: string): void {
  if (path.startsWith("file:")) return;
  const parent = dirname(path);
  if (parent === "" || parent === ".") return;
  mkdirSync(parent, { recursive: true });
}

/**
 * K1: pi-durable merges object fields over its defaults and reads the value at every use, so the facade
 * hands it a getter. The returned object is rebuilt per read; mutating it has no effect on the harness.
 */
function settingsGetter(options: OpenHarnessOptions): () => HarnessSettings {
  return () => {
    const overrides = options.settings;
    return {
      progress: { partialIntervalMs: DEFAULT_PARTIAL_INTERVAL_MS, ...overrides?.progress },
      retry: { maxRetries: DEFAULT_MAX_RETRIES, ...overrides?.retry },
      ...(overrides?.restartLimit === undefined ? {} : { restartLimit: overrides.restartLimit }),
      ...(overrides?.afterFailedRun === undefined ? {} : { afterFailedRun: overrides.afterFailedRun }),
    };
  };
}

/** K1: failures that do not fail the caller go to the T2 logger rather than to console.log. */
function reportHandler(logger: Logger): (report: Report) => void {
  return (report) => {
    const { error, ...info } = report;
    logger.warn("pi-durable report", { ...info, error });
  };
}

/**
 * Implementation behind `openHarness()` in `src/contracts/harness.ts` (which loads it lazily so the contract
 * module stays free of pi-durable imports). See the module comment for the order of opening.
 */
export async function openHarnessCore(
  cfg: HarnessConfig,
  options: OpenHarnessOptions = {},
): Promise<Core> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const logger = options.logger ?? DEFAULT_LOGGER;

  const dbPath = resolveDatabasePath(cfg, options.storage);
  ensureParentDirectory(dbPath);

  // K2: one connection for durable and domain tables; the storage adapter does not own a second one.
  const db = await openNodeSqliteDatabase(
    dbPath,
    options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs },
  );
  const storage = await SqliteStorage.open(db, { prefix: PI_SCHEMA_PREFIX });

  const models = options.models ?? buildModels();
  if (options.models === undefined) warnAboutMissingModels(models, cfg, logger);

  const registry = createRegistry();
  for (const extension of options.extensions ?? []) registry.install(extension);

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      identity: options.identity ?? { attribution: APP_ATTRIBUTION },
      settings: settingsGetter(options),
      onReport: options.onReport ?? reportHandler(logger),
      now: options.now,
      setTimer: options.setTimer,
    },
    context,
  );

  const deps: ConversationDeps = {
    harness,
    chatModel: conversationModelRef(cfg),
    context,
  };

  let closing: Promise<void> | undefined;

  const core: Core = {
    harness,
    db,
    storage,
    actors: createActorDirectory(harness, context),

    async resume(): Promise<void> {
      // Synchronous on purpose in pi-durable (K9); the promise is for the boot sequence.
      harness.resume();
    },

    async close(): Promise<void> {
      closing ??= harness.close(context);
      return closing;
    },

    getOrCreateConversation(userId: string, role: Role): Promise<CoreConversation> {
      return getOrCreateConversation(deps, userId, role);
    },

    conversation(userId: string): Promise<CoreConversation | null> {
      return conversationByUser(deps, userId);
    },

    submitUserInput(
      conversation: CoreConversation,
      input: UserInput,
      submitOptions?: SubmitUserInputOptions,
    ): Promise<PendingTurn> {
      return submitTurn(conversation.handle, input, submitOptions);
    },

    watchText(
      conversation: CoreConversation,
      listener: TextDeltaListener,
      watchOptions?: WatchTextOptions,
    ): Promise<TextStream> {
      return watchConversationText(conversation.handle, listener, watchOptions);
    },

    echo(
      conversation: CoreConversation,
      text: string,
      echoOptions?: EchoOptions,
    ): Promise<EchoTurn> {
      return echoTurn(conversation.handle, text, echoOptions);
    },

    abort(conversation: CoreConversation, abortContext?): Promise<void> {
      return abortConversation(conversation.handle, abortContext ?? context);
    },
  };

  registries.set(core, registry);
  return core;
}

// ---------------------------------------------------------------------------
// Extensions (A1, M2)
// ---------------------------------------------------------------------------

/**
 * The registry of an open core. `Core` keeps the registry out of the contract on purpose (the facade is
 * what callers should use), so extensions are installed through {@link installExtensions}.
 */
export function registryFor(core: Core): Registry {
  const registry = registries.get(core);
  if (registry === undefined) {
    throw new Error("core was not opened by openHarness(); no registry is attached to it");
  }
  return registry;
}

/**
 * A1/M2: install agent extensions into a running core. pi-durable publishes registry changes at once, so a
 * conversation blocked on a missing tool or task definition picks them up without a restart (K7).
 */
export function installExtensions(core: Core, extensions: readonly Extension[]): void {
  const registry = registryFor(core);
  for (const extension of extensions) registry.install(extension);
}

// ---------------------------------------------------------------------------
// Shutdown (K11)
// ---------------------------------------------------------------------------

export interface ShutdownOptions {
  /** Safety net for a hanging `close()`; default 10 s (K11's SIGTERM recipe). */
  readonly timeoutMs?: number;
  /** Called with `1` when `close()` did not return in time. Default `process.exit`. */
  readonly hardExit?: (code: number) => void;
  readonly logger?: Logger;
}

/** Per-core shutdown, so two signals (SIGTERM then SIGINT) close once. */
const shutdowns = new WeakMap<Core, Promise<void>>();

/**
 * K11: the function `src/index.ts` calls from its `SIGTERM`/`SIGINT` handler.
 *
 * `close()` seals admission, settles admitted commits and waits for running task code; commits are atomic
 * and unfinished work is picked up by `resume()` on the next boot, so nothing extra needs to be written.
 * The safety timer only guards against a `close()` that never returns (a task ignoring its abort signal).
 */
export function shutdown(core: Core, options: ShutdownOptions = {}): Promise<void> {
  const existing = shutdowns.get(core);
  if (existing !== undefined) return existing;

  const logger = options.logger ?? DEFAULT_LOGGER;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const hardExit = options.hardExit ?? ((code: number) => process.exit(code));

  const timer = setTimeout(() => {
    logger.warn("durable close timed out", { timeoutMs });
    hardExit(1);
  }, timeoutMs);
  timer.unref();

  const running = core.close().finally(() => {
    clearTimeout(timer);
  });
  shutdowns.set(core, running);
  return running;
}
