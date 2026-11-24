/**
 * Boot wiring (I2): the one place where domain, LLM, agent, verify task and server are assembled.
 *
 * `src/index.ts` keeps only the process concerns (config, `listen`, signals); everything that must
 * be constructed **in a specific order** is here, because that order is the integration:
 *
 * 1. **core** (`S1`) — one SQLite file shared by durable and domain tables (K2). Opened before
 *    anything else: the domain repositories query through `core.db`, so there is exactly one
 *    connection and no second writer;
 * 2. **domain** (`D2`) — `openDomain({ db: core.db, dataDir })`, then `migrate()`. Migrations run on
 *    every boot: they are idempotent, and a half-migrated file must never reach the tools;
 * 3. **LLM clients** (`V2`) — `createLlmClients` over the *same* `Models` collection the harness
 *    holds, so provider auth and the catalogue cannot diverge between the agent and the verify task;
 * 4. **verify extension** — installed **before** the spawner, because `createVerifySpawner` resolves
 *    the task through the registry and throws when it is missing;
 * 5. **tools** (`A2`) — `createHmwrkTools` over the repositories and the verify spawner, handed to
 *    the agent through A1's `AgentDeps.tools` seam (one extension, one toolset, both roles);
 * 6. **agent extension** (`A1`) — prompt section + the nine tools + the SPEC §6 assignment summary,
 *    which boot provides over `AssignmentsRepo`;
 * 7. **roles** (ADR 0004) — `hybrid`: OpenWebUI headers + the `users` row first, static keys as the
 *    fallback for a caller that sends no user context;
 * 8. **turn runner** — the real agent (generation) or, with `HMWRK_ECHO=1`, the M1 echo.
 *
 * The faux-LLM hook (`HMWRK_FAUX_LLM=1`, see `src/faux.ts`) swaps steps 3–4 to scripted models and
 * is the only reason `llm` is injectable: tests pass their own `Models` the same way.
 */

import { mkdirSync } from "node:fs";
import { buildModels, installExtensions } from "./durable/index.js";
import { createVerifyExtension, createVerifySpawner } from "./durable/tasks/verify.js";
import type { Models } from "@earendil-works/pi-ai";
import { buildAgentExtensions } from "./agent/index.js";
import { MAX_ASSIGNMENT_LINES } from "./agent/prompt.js";
import { createHmwrkTools } from "./agent/tools/index.js";
import type { Config, Logger, ModelsConfig } from "./config/index.js";
import { createLogger } from "./config/index.js";
import type { Core, OpenHarnessOptions } from "./contracts/harness.js";
import { openHarness } from "./contracts/harness.js";
import type { AssignmentSummaryProvider, RoleResolver } from "./contracts/index.js";
import type { Repos } from "./domain/index.js";
import { createFauxLlm } from "./faux.js";
import { createLlmClients, type LlmClients } from "./llm/index.js";
import { createRoleResolver } from "./server/auth.js";
import { createApp, echoTurnRunner } from "./server/routes.js";
import { generationTurnRunner } from "./server/turn.js";
import { openDomain, type Domain } from "./store/index.js";

/** A model collection plus the slot refs that resolve into it. */
export interface LlmSetup {
  readonly models: Models;
  readonly slots: ModelsConfig;
}

/** The Hono app type without exporting `AppEnv` from the server module. */
export type HmwrkHonoApp = ReturnType<typeof createApp>;

export interface CreateHmwrkAppOptions {
  /** Loaded configuration (`src/config`); the caller owns `dataDir`, this function creates it. */
  readonly config: Config;
  readonly logger?: Logger;
  /** Opens the durable core. Default: S1's `openHarness`. Injected only by tests. */
  readonly openCore?: (config: Config, options: OpenHarnessOptions) => Promise<Core>;
  /** Test/faux seam: the `Models` collection and slot refs to use instead of groq/mistral. */
  readonly llm?: LlmSetup;
  /** Clock handed to the tools and the prompt; default: the wall clock. */
  readonly now?: () => Date;
}

/** Everything boot produced, exposed for `src/index.ts` and for integration tests. */
export interface HmwrkApp {
  readonly app: HmwrkHonoApp;
  readonly core: Core;
  readonly domain: Domain;
  /** The config actually used (with faux slots substituted when the faux hook is on). */
  readonly config: Config;
  readonly resolver: RoleResolver;
  readonly llm: LlmClients;
  /** Closes the core (tasks settle, storage closes). The HTTP server is the caller's. */
  close(): Promise<void>;
}

/** Assignment statuses the prompt summarises: still to be done, and waiting for a verdict. */
const SUMMARY_STATUSES = ["active", "in_review"] as const;

/**
 * SPEC §6: «активные задания (кратко)» for the system prompt.
 *
 * Two statuses, because both are still work in the family's eyes («ждёт отчёта» / «на проверке»).
 * Capped at the renderer's limit plus a margin for the overdue sort, so one huge backlog cannot
 * make the prompt slow or long — `renderAgentPrompt` keeps the first {@link MAX_ASSIGNMENT_LINES}
 * and adds «…и ещё N».
 */
export function createAssignmentSummary(repos: Pick<Repos, "assignments">): AssignmentSummaryProvider {
  return async () => {
    const rows = await repos.assignments.list({
      status: [...SUMMARY_STATUSES],
      limit: MAX_ASSIGNMENT_LINES * 4,
    });
    return rows.map((assignment) => ({
      subject: assignment.subject,
      due_at: assignment.due_at,
      status: assignment.status,
    }));
  };
}

/**
 * Build the wired application. Nothing here listens on a socket.
 *
 * `migrate()` and `resume()` both run before the app is handed out: the first request must not race
 * the schema, and recovered tasks (an interrupted verify) should already be scheduled.
 */
export async function createHmwrkApp(options: CreateHmwrkAppOptions): Promise<HmwrkApp> {
  const logger = options.logger ?? createLogger({ bindings: { module: "app" } });

  // Config resolves paths but never touches the filesystem; boot owns creating them.
  mkdirSync(options.config.dataDir, { recursive: true });

  const llmSetup = await resolveLlmSetup(options, logger);
  const config: Config = llmSetup.slots === options.config.models
    ? options.config
    : { ...options.config, models: llmSetup.slots };

  const openCore = options.openCore ?? ((cfg: Config, harnessOptions: OpenHarnessOptions) => openHarness(cfg, harnessOptions));
  const core = await openCore(config, { models: llmSetup.models, logger: logger.child({ module: "durable" }) });

  // D2: repositories over the durable connection (K2), then the schema. Migrations are idempotent,
  // and a request must never reach an un-migrated table.
  const domain = openDomain({ db: core.db, dataDir: config.dataDir });
  const migrated = await domain.migrate();
  logger.info("domain schema ready", {
    version: migrated.version,
    applied: migrated.applied.map((migration) => migration.name),
  });

  // V2: the three clients over the same Models collection the harness holds.
  const llm = createLlmClients({
    models: llmSetup.models,
    slots: config.models,
    logger: logger.child({ module: "llm" }),
  });

  // V2: the verify task must be registered before the spawner resolves it (registry snapshot).
  installExtensions(core, [
    createVerifyExtension({
      llm,
      repos: domain.repos,
      photosDir: config.photosDir,
      logger: logger.child({ module: "verify" }),
    }),
  ]);
  const spawnVerify = createVerifySpawner(core);

  // A2 → A1: the nine tools through the agent's own seam; the role comes from `core.actors`.
  const now = options.now;
  const tools = createHmwrkTools(
    { repos: domain.repos, spawnVerify, now: () => (now ?? (() => new Date()))() },
    core.actors,
  );

  const extensions = buildAgentExtensions({
    deps: {
      actors: core.actors,
      models: config.models,
      repos: domain.repos,
      tools,
      assignmentSummary: createAssignmentSummary(domain.repos),
      ...(now === undefined ? {} : { now }),
    },
  });
  installExtensions(core, extensions);
  logger.info("agent extension installed", {
    extensions: extensions.map((extension) => extension.name),
    tools: Object.keys(tools).length,
  });

  // ADR 0004: headers + users row first (hybrid), static keys as the fallback.
  const resolver = createRoleResolver({
    keys: config.roles,
    users: domain.repos.users,
    mode: "hybrid",
  });
  logger.info("role resolver configured", { mode: resolver.mode });

  const turnRunner = config.echo
    ? echoTurnRunner(core)
    : generationTurnRunner(core, { logger: logger.child({ module: "turn" }) });
  logger.info(config.echo ? "answering with echo (HMWRK_ECHO=1)" : "answering with the agent", {
    models: config.models,
  });

  const app = createApp({
    core,
    resolver,
    logger,
    turnRunner,
    photoIntake: domain.photoFiles,
  });

  // Already wired: recovered tasks can start as soon as the scheduler runs.
  await core.resume();

  return {
    app,
    core,
    domain,
    config,
    resolver,
    llm,
    close: () => core.close(),
  };
}

/**
 * The `Models` collection and slot refs: injected (tests), faux (`HMWRK_FAUX_LLM=1`) or the
 * groq/mistral catalogue `models.json` names (production, K8).
 */
async function resolveLlmSetup(options: CreateHmwrkAppOptions, logger: Logger): Promise<LlmSetup> {
  if (options.llm !== undefined) return options.llm;
  if (options.config.faux.enabled) {
    logger.warn("HMWRK_FAUX_LLM is on: answers come from pi-ai's faux provider, not from a real model", {
      script: options.config.faux.scriptPath,
    });
    return createFauxLlm({
      ...(options.config.faux.scriptPath === undefined ? {} : { scriptPath: options.config.faux.scriptPath }),
      logger: logger.child({ module: "faux" }),
    });
  }
  return { models: buildModels(), slots: options.config.models };
}
