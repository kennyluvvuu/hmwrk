/**
 * `hmwrk.reminder` and `hmwrk.digest` — the two scheduled broadcasts (SPEC §5.6).
 *
 * Both are the same durable state machine, differing only in the wall-clock setting, the role that
 * receives the message and what is collected:
 *
 * 1. `schedule` reads the effective settings and sleeps until the next occurrence of
 *    `reminder_time` / `digest_time` (today when it is still ahead, otherwise tomorrow);
 * 2. `fire` checks `paused_until`, collects the message body, resolves the Telegram chats of the
 *    role and sends; then it returns to `schedule`, which recomputes the next occurrence.
 *
 * Consequences of that shape (K9):
 * - the task never ends, so it survives restarts as a sleeping record and needs no cron: boot calls
 *   `createNotifyScheduler(core).ensureScheduled()` + `resume()`;
 * - a settings change needs no task surgery: the next `schedule` phase reads the values again, so a
 *   new `reminder_time` takes effect after the next firing (I3 may additionally abort/recreate the
 *   task to apply it immediately — see the N1 report);
 * - a firing must never fail the task: a missing binding, an empty message and a Telegram error are
 *   all `skipped` results, because the next chance is tomorrow's scheduled firing, not a retry;
 * - the last firing's {@link NotifyFireResult} is kept in the checkpoint, so the state of the task
 *   after a scheduled wake is observable without logs (and in tests).
 *
 * Message text is injected ({@link NotifyDeps.renderReminder} / {@link NotifyDeps.renderDigest}):
 * the G1T templates (`src/telegram/templates.ts`) arrive in I3, and this module must not import
 * `src/telegram/**`.
 *
 * All calendar math goes through `src/domain/dates.ts`, i.e. the process local timezone (TZ), the
 * same clock the rest of the domain uses for `reminder_time`, `digest_time` and `paused_until`.
 */

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTask,
  type Extension,
  type Task,
  type TaskId,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { Logger } from "../../config/index.js";
import { createLogger } from "../../config/index.js";
import type { Core } from "../../contracts/harness.js";
import type { TelegramSender } from "../../contracts/notify.js";
import {
  DAY_MS,
  addLocalDays,
  atLocalTime,
  isPaused,
  startOfLocalDay,
  toIso,
  type Assignment,
  type AssignmentWithItems,
  type CheckIn,
  type IsoDateTime,
  type Repos,
  type Role,
  type Settings,
  type TimeOfDay,
  type Verification,
} from "../../domain/index.js";
import { registryFor } from "../harness.js";

/** Registered task kind; persisted in `TaskRecord.kind`, so renaming it is a migration. */
export const REMINDER_TASK_NAME = "hmwrk.reminder";

/** Registered task kind; persisted in `TaskRecord.kind`, so renaming it is a migration. */
export const DIGEST_TASK_NAME = "hmwrk.digest";

/** Definition version of both tasks. Bump together with a `migrate()` when a checkpoint shape changes. */
export const NOTIFY_TASK_VERSION = 1;

/** Extension name; `createNotifyScheduler` resolves both tasks through the installed registry. */
export const NOTIFY_EXTENSION_NAME = "hmwrk-notify";

/** Which broadcast a task is. */
export type NotifyKind = "reminder" | "digest";

/**
 * Both tasks take no input: the schedule lives in settings and is re-read at every `schedule`
 * phase, so a task never carries a stale copy of `reminder_time`/`digest_time`.
 */
export type NotifyTaskInput = Record<string, never>;

/** Why a firing sent nothing. Every one of them is a normal, non-failing outcome. */
export type NotifySkipReason =
  /** `paused_until` covers this local day (SPEC §5.6, T1 `isPaused`). */
  | "paused"
  /** There was something to say, but nobody of the target role has a Telegram chat bound. */
  | "no_binding"
  /** Nothing to report (no due homework for the reminder, all digest sections empty). */
  | "empty"
  /** `sendMessage` failed for every recipient; no retry — tomorrow's firing is the retry. */
  | "send_failed"
  /**
   * Unexpected failure while collecting the body (repository or renderer error). Recorded instead of
   * faulting the phase, because a fault would end the schedule and the broadcast would stay dead until
   * the next boot; tomorrow's firing is the retry.
   */
  | "error";

/** One firing, kept in the checkpoint as `last` (see the module comment). */
export interface NotifyFireResult {
  readonly kind: NotifyKind;
  readonly status: "sent" | "skipped";
  /** `null` after a successful delivery. */
  readonly reason: NotifySkipReason | null;
  /** Harness-clock instant of the firing. */
  readonly at: IsoDateTime;
  /** Chats the message was handed to (`0` when nothing was sent). */
  readonly recipients: number;
  /** How many things the message was built from (`0` = nothing to report). */
  readonly entries: number;
}

/** Checkpoint. `last` survives a sleep so the outcome of the previous firing stays readable. */
export type NotifyState =
  | { readonly phase: "schedule"; readonly last: NotifyFireResult | null }
  | { readonly phase: "fire"; readonly last: NotifyFireResult | null };

/**
 * Terminal result type of both tasks: they never complete on their own (only `aborted` is ever
 * produced), so there is no `completed` payload to model.
 */
export type NotifyTaskResult = never;

// ---------------------------------------------------------------------------
// Message bodies (injected renderers)
// ---------------------------------------------------------------------------

/** A check-in made today, with the assignment it reports on (digest «что сдано сегодня»). */
export interface DigestSubmitted {
  readonly assignment: Assignment;
  readonly checkIn: CheckIn;
}

/** A draft verdict awaiting the parent's decision. `assignment` is `null` if it vanished. */
export interface DigestPendingVerdict {
  readonly verification: Verification;
  readonly assignment: Assignment | null;
}

/** Everything the parent digest talks about (SPEC §5.6). */
export interface DigestSections {
  /** Check-ins created today, local time. */
  readonly submittedToday: readonly DigestSubmitted[];
  /** Active assignments past their due instant without a check-in. */
  readonly overdue: readonly Assignment[];
  /** Drafts awaiting approval (`VerificationsRepo.listPending`). */
  readonly pendingVerdicts: readonly DigestPendingVerdict[];
  /**
   * Intake screenshots still waiting for confirmation. SPEC §5.3 keeps no drafts table
   * (confirmation *is* assignment creation), so this list is the observable proxy — see
   * {@link collectParserDrafts} — and is normally empty.
   */
  readonly parserDrafts: readonly Assignment[];
}

/** Renders the child reminder from the assignments due in the next 24 h without a check-in. */
export type ReminderRenderer = (assignments: readonly AssignmentWithItems[]) => string;

/** Renders the parent digest from its sections. */
export type DigestRenderer = (sections: DigestSections) => string;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface NotifyDeps {
  /** G1T client (Telegram Bot API); a fake in tests. */
  sender: TelegramSender;
  /** Domain repositories (D2 in production, in-memory fakes in tests). */
  repos: Repos;
  /** G1T template for the child reminder. */
  renderReminder: ReminderRenderer;
  /** G1T template for the parent digest. */
  renderDigest: DigestRenderer;
  logger?: Logger;
  /**
   * Clock override. Default: the harness clock (`runtime.now()`), which is what the durable scheduler
   * sleeps against and what tests replace with a fake clock (K9).
   */
  now?: () => Date;
}

const DEFAULT_LOGGER: Logger = createLogger({ bindings: { module: "notify" } });

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Next instant the wall-clock time `time` occurs, local time: today when it is still strictly ahead,
 * otherwise tomorrow. Strictly, because a wake happens exactly at `until` — with `>=` the task would
 * schedule itself for the instant it just woke at and fire in a loop.
 */
export function nextRunAt(time: TimeOfDay, now: Date): Date {
  const today = atLocalTime(now, time);
  return today.getTime() > now.getTime() ? today : atLocalTime(addLocalDays(now, 1), time);
}

/** Per-kind pieces the shared state machine uses. */
interface NotifyKindSpec {
  readonly kind: NotifyKind;
  readonly taskName: string;
  readonly timeKey: "reminder_time" | "digest_time";
  /** Role whose Telegram chats receive the message (SPEC §5.6). */
  readonly role: Role;
  /** Builds the message body; `null` when there is nothing to report. */
  collect(deps: NotifyDeps, now: Date, settings: Settings): Promise<NotifyMessage | null>;
}

interface NotifyMessage {
  readonly text: string;
  readonly entries: number;
}

/** Reminder: active assignments due in the next 24 h that nobody has reported yet (SPEC §5.6). */
async function collectReminder(deps: NotifyDeps, now: Date): Promise<NotifyMessage | null> {
  const horizon = new Date(now.getTime() + DAY_MS);
  const assignments = await deps.repos.assignments.listWithItems({
    status: "active",
    hasCheckIn: false,
    dueAfter: toIso(now),
    dueBefore: toIso(horizon),
  });
  if (assignments.length === 0) return null;
  const text = deps.renderReminder(assignments);
  if (text.trim() === "") return null;
  return { text, entries: assignments.length };
}

/** Digest: submitted today, overdue, pending verdicts, parser drafts (SPEC §5.6). */
async function collectDigest(deps: NotifyDeps, now: Date): Promise<NotifyMessage | null> {
  const [checkIns, overdue, pendingVerdicts, parserDrafts] = await Promise.all([
    deps.repos.checkIns.listSince(startOfLocalDay(now)),
    deps.repos.assignments.listOverdue(now),
    deps.repos.verifications.listPending(),
    collectParserDrafts(deps.repos),
  ]);

  const submittedToday: DigestSubmitted[] = [];
  for (const checkIn of checkIns) {
    const assignment = await deps.repos.assignments.get(checkIn.assignment_id);
    if (assignment === null) continue;
    submittedToday.push({ assignment, checkIn });
  }

  const pending: DigestPendingVerdict[] = [];
  for (const verification of pendingVerdicts) {
    const checkIn = await deps.repos.checkIns.get(verification.checkin_id);
    const assignment = checkIn === null ? null : await deps.repos.assignments.get(checkIn.assignment_id);
    pending.push({ verification, assignment });
  }

  const entries = submittedToday.length + overdue.length + pending.length + parserDrafts.length;
  if (entries === 0) return null;
  return {
    text: deps.renderDigest({ submittedToday, overdue, pendingVerdicts: pending, parserDrafts }),
    entries,
  };
}

/**
 * Screenshots still awaiting the parent's confirmation. SPEC §5.3 deliberately keeps no drafts
 * table («подтверждение — это просто создание заданий»), so «waiting for confirmation» lives in the
 * conversation, not in the database. The only observable proxy is an intake-sourced assignment that
 * never got its items; normally this list is empty and I3 can replace it if P1 keeps its drafts
 * durable after all.
 */
async function collectParserDrafts(repos: Repos): Promise<Assignment[]> {
  const active = await repos.assignments.listWithItems({ status: "active" });
  return active
    .filter((assignment) => assignment.source === "screenshot" && assignment.items.length === 0)
    .map(({ items: _items, ...assignment }) => assignment);
}

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------

function phaseClock(deps: NotifyDeps, runtime: TaskRuntime<NotifyTaskInput, NotifyState, NotifyTaskResult, object>) {
  return deps.now ?? (() => new Date(runtime.now()));
}

/** The state machine shared by both broadcasts; `spec` decides time, role and content. */
function createNotifyTask(spec: NotifyKindSpec, deps: NotifyDeps) {
  const logger = deps.logger ?? DEFAULT_LOGGER;

  return defineTask<NotifyTaskInput, NotifyState, NotifyTaskResult>({
    name: spec.taskName,
    version: NOTIFY_TASK_VERSION,
    initial: () => ({ phase: "schedule", last: null }),

    phases: {
      schedule: async (task, runtime, context) => {
        const clock = phaseClock(deps, runtime);
        const settings = await deps.repos.settings.getAll();
        const at = nextRunAt(settings[spec.timeKey], clock());
        logger.debug("notify: sleeping until the next window", {
          kind: spec.kind,
          time: settings[spec.timeKey],
          until: toIso(at),
        });
        await runtime.sleepUntil(at.getTime(), { phase: "fire", last: task.state.checkpoint.last }, context);
      },

      fire: async (_task, runtime, context) => {
        const clock = phaseClock(deps, runtime);
        const result = await fireOnce(spec, deps, logger, clock());
        // Back to `schedule` in the same invocation: it reads the settings again and sleeps until
        // the next day's window, so a changed time takes effect from the next firing on.
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "schedule", last: result } }),
          context,
        );
      },
    },

    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
}

/** The child reminder task (SPEC §5.6): `reminder_time`, default 19:00. */
export function createReminderTask(deps: NotifyDeps) {
  return createNotifyTask(
    {
      kind: "reminder",
      taskName: REMINDER_TASK_NAME,
      timeKey: "reminder_time",
      role: "child",
      collect: collectReminder,
    },
    deps,
  );
}

/** The parent digest task (SPEC §5.6): `digest_time`, default 21:00. */
export function createDigestTask(deps: NotifyDeps) {
  return createNotifyTask(
    {
      kind: "digest",
      taskName: DIGEST_TASK_NAME,
      timeKey: "digest_time",
      role: "parent",
      collect: collectDigest,
    },
    deps,
  );
}

/** The `hmwrk-notify` extension: registers both scheduled tasks. No tools, no prompt section. */
export function createNotifyExtension(
  deps: NotifyDeps,
  tasks: readonly [Task<NotifyTaskInput, NotifyState, NotifyTaskResult, object>, Task<NotifyTaskInput, NotifyState, NotifyTaskResult, object>] = [
    createReminderTask(deps),
    createDigestTask(deps),
  ],
): Extension {
  return defineExtension({ name: NOTIFY_EXTENSION_NAME, tasks: [...tasks] });
}

// ---------------------------------------------------------------------------
// One firing
// ---------------------------------------------------------------------------

async function fireOnce(
  spec: NotifyKindSpec,
  deps: NotifyDeps,
  logger: Logger,
  now: Date,
): Promise<NotifyFireResult> {
  try {
    return await deliver(spec, deps, logger, now);
  } catch (error) {
    // A faulting phase would end the task at `failed` and stop the nightly broadcast until the next
    // boot recreates it (see `ensureScheduled`), so an unexpected error is recorded and re-scheduled.
    logger.error("notify: firing failed unexpectedly, giving up until the next window", {
      kind: spec.kind,
      error: errorMessage(error),
    });
    return { kind: spec.kind, at: toIso(now), status: "skipped", reason: "error", recipients: 0, entries: 0 };
  }
}

async function deliver(
  spec: NotifyKindSpec,
  deps: NotifyDeps,
  logger: Logger,
  now: Date,
): Promise<NotifyFireResult> {
  const at = toIso(now);
  const base = { kind: spec.kind, at } as const;
  const settings = await deps.repos.settings.getAll();

  if (isPaused(settings, now)) {
    logger.info("notify: broadcasts are paused, nothing is sent", {
      kind: spec.kind,
      pausedUntil: settings.paused_until,
    });
    return { ...base, status: "skipped", reason: "paused", recipients: 0, entries: 0 };
  }

  const message = await spec.collect(deps, now, settings);
  if (message === null) {
    logger.info("notify: nothing to report, nothing is sent", { kind: spec.kind });
    return { ...base, status: "skipped", reason: "empty", recipients: 0, entries: 0 };
  }

  const chatIds = await recipientChats(deps.repos, spec.role);
  if (chatIds.length === 0) {
    logger.warn("notify: no Telegram chat is bound to the role, nothing is sent", {
      kind: spec.kind,
      role: spec.role,
      entries: message.entries,
    });
    return { ...base, status: "skipped", reason: "no_binding", recipients: 0, entries: message.entries };
  }

  let delivered = 0;
  for (const chatId of chatIds) {
    try {
      await deps.sender.sendMessage({ chatId, text: message.text });
      delivered += 1;
    } catch (error) {
      // No retry: the task's next scheduled firing is tomorrow (SPEC §5.6 — no per-deadline alerts).
      logger.warn("notify: sendMessage failed, giving up until the next window", {
        kind: spec.kind,
        chatId,
        error: errorMessage(error),
      });
    }
  }

  if (delivered === 0) {
    return { ...base, status: "skipped", reason: "send_failed", recipients: 0, entries: message.entries };
  }
  logger.info("notify: message delivered", {
    kind: spec.kind,
    recipients: delivered,
    entries: message.entries,
  });
  return { ...base, status: "sent", reason: null, recipients: delivered, entries: message.entries };
}

/**
 * Telegram chats of every user with `role` that has a binding. Multi-child households are outside
 * the MVP (SPEC §10), so all children of the role get the same reminder text; the domain itself is
 * already parameterised by `users`.
 */
async function recipientChats(repos: Repos, role: Role): Promise<string[]> {
  const users = await repos.users.listByRole(role);
  const chatIds: string[] = [];
  for (const user of users) {
    const binding = await repos.tgBindings.getByUserId(user.id);
    if (binding === null) continue;
    if (!chatIds.includes(binding.chat_id)) chatIds.push(binding.chat_id);
  }
  return chatIds;
}

// ---------------------------------------------------------------------------
// Boot wiring (I3)
// ---------------------------------------------------------------------------

export interface NotifySchedulerOptions {
  /** Invocation context; default `BACKGROUND_CONTEXT`. */
  context?: Context;
}

/** Ids of the two scheduled tasks (stable across restarts while they stay alive). */
export interface NotifyScheduledTasks {
  readonly reminderTaskId: string;
  readonly digestTaskId: string;
}

/**
 * Boot-time scheduling (K9: «schedule at start» = `createTask` + `resume()`, never cron).
 *
 * `ensureScheduled()` is idempotent: it looks for a live (non-terminal) task of each kind and creates
 * only the missing ones, then enables the scheduler. Install {@link createNotifyExtension} first.
 */
export interface NotifyScheduler {
  ensureScheduled(): Promise<NotifyScheduledTasks>;
}

/** Scheduler over an open core; the task objects come from the installed registry (as V2 does). */
export function createNotifyScheduler(core: Core, options: NotifySchedulerOptions = {}): NotifyScheduler {
  const context = options.context ?? BACKGROUND_CONTEXT;

  function taskFor(taskName: string): Task<NotifyTaskInput, NotifyState, NotifyTaskResult, object> {
    const installed = registryFor(core).snapshot().task(taskName);
    if (installed === undefined) {
      throw new Error(
        `task ${taskName} is not registered; install createNotifyExtension() before createNotifyScheduler()`,
      );
    }
    return installed as unknown as Task<NotifyTaskInput, NotifyState, NotifyTaskResult, object>;
  }

  async function liveTaskId(taskName: string): Promise<TaskId<NotifyTaskResult> | undefined> {
    // Newest first: an earlier record of the same kind may already be terminal (e.g. aborted by a
    // settings change) while the live one is newer. `scanTasks` lives on the commit surface (Tx),
    // and a read-only commit writes nothing.
    const page = await core.harness.commit(
      (tx) => tx.scanTasks({ kind: taskName, order: "descending" }, 1),
      context,
    );
    const record = page.items[0];
    if (record === undefined) return undefined;
    if (record.state.status === "terminal" || record.state.status === "completing") return undefined;
    return record.id as unknown as TaskId<NotifyTaskResult>;
  }

  return {
    async ensureScheduled(): Promise<NotifyScheduledTasks> {
      const kinds = [REMINDER_TASK_NAME, DIGEST_TASK_NAME] as const;
      const ids = new Map<string, TaskId<NotifyTaskResult>>();
      const missing: string[] = [];
      for (const kind of kinds) {
        const live = await liveTaskId(kind);
        if (live === undefined) missing.push(kind);
        else ids.set(kind, live);
      }

      if (missing.length > 0) {
        // The household root conversation owns both: a nightly broadcast is not a chat turn of one
        // person, so an abort of somebody's chat must not cascade into it.
        const root = await core.harness.root(context);
        const created = await core.harness.commit(async (tx) => {
          const out: TaskId<NotifyTaskResult>[] = [];
          for (const kind of missing) {
            out.push(
              await tx.createTask(taskFor(kind), {} as NotifyTaskInput, {
                ownership: { kind: "conversation" },
                conversationId: root.id,
              }),
            );
          }
          return out;
        }, context);
        for (const [index, kind] of missing.entries()) {
          const id = created[index];
          if (id !== undefined) ids.set(kind, id);
        }
      }

      // Idempotent (K9): enables scheduling and recovers interrupted work on every boot.
      core.harness.resume();

      const reminderTaskId = ids.get(REMINDER_TASK_NAME);
      const digestTaskId = ids.get(DIGEST_TASK_NAME);
      if (reminderTaskId === undefined || digestTaskId === undefined) {
        throw new Error("notify tasks were not created");
      }
      return { reminderTaskId: String(reminderTaskId), digestTaskId: String(digestTaskId) };
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
