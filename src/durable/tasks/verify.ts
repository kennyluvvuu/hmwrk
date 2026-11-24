/**
 * `hmwrk.verify` — the two-stage verification task (SPEC §5.4).
 *
 * Phases, each a durable checkpoint:
 * 1. `load` — check-in → photos → assignment → items, plus the idempotency check;
 * 2. `read` — the vision model (`read` slot) transcribes the notebook photos;
 * 3. `check` — the text model (`verify` slot) solves the assignment and grades the transcription;
 * 4. `save` — one `draft` verification with per-item findings (`VerificationsRepo`).
 *
 * What this task deliberately does *not* do: touch the assignment status. `in_review → done` is
 * the parent's approval (I2 / `approve_verification`); the AI verdict is always a draft.
 *
 * Failures are explicit durable `failed` outcomes: an unknown check-in, a check-in without
 * photos, an unreadable photo, an LLM error after its own retry. Re-running is a new task, and
 * a check-in that already has a verification is not analysed twice unless `force` is set
 * (the recompute path when photos are added — I2 passes it through the lower-level task input;
 * `VerifySpawner` intentionally only offers the idempotent call).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTask,
  type ConversationId,
  type Extension,
  type Task,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { Logger } from "../../config/index.js";
import { createLogger } from "../../config/index.js";
import type { VerifySpawner } from "../../contracts/tasks.js";
import type { Core } from "../../contracts/harness.js";
import type {
  AssignmentWithItems,
  FindingVerdict,
  Id,
  Photo,
  Repos,
  VerificationWithFindings,
} from "../../domain/index.js";
import type { NewVerificationFindingInput } from "../../domain/repo.js";
import { LlmError, type LlmClients, type VerifyHomeworkResult } from "../../llm/index.js";
import { registryFor } from "../harness.js";

/** Registered task kind; persisted in `TaskRecord.kind`, so renaming it is a migration. */
export const VERIFY_TASK_NAME = "hmwrk.verify";

/** Definition version. Bump together with a `migrate()` when the input/checkpoint shape changes. */
export const VERIFY_TASK_VERSION = 1;

/** Extension name; `createVerifySpawner` resolves the task through it. */
export const VERIFY_EXTENSION_NAME = "hmwrk-verify";

/** What the vision stage is asked to do. Reused verbatim in logs/tests. */
export const READ_PROMPT = [
  "Ты — первый этап проверки домашней работы. На фотографиях — тетрадь ребёнка.",
  "Перепиши решения по пунктам: для каждого пункта задания — его подпись и то, что написано в тетради.",
  "Не решай задания и не исправляй ошибки — только точная расшифровка.",
  "Если почерк или качество фото не позволяют разобрать фрагмент, скажи это прямо.",
  "Если решения пункта на фото нет — напиши «не видно».",
].join("\n");

// ---------------------------------------------------------------------------
// Input, checkpoint and result shapes
// ---------------------------------------------------------------------------

export interface VerifyTaskInput {
  /** `checkins.id` to analyse. */
  checkInId: Id;
  /**
   * Recompute even when a verification already exists (photos were added to the check-in).
   * `VerifySpawner.startVerify` never sets it; I2 uses the task directly for the recompute flow.
   */
  force?: boolean;
}

/** Everything the later phases need, captured in one checkpoint by `load`. */
export interface VerifyPayload {
  checkInId: Id;
  assignmentId: Id;
  childUserId: Id;
  /** Subject/due/note rendered for the verify model. */
  assignmentText: string;
  items: readonly VerifyPayloadItem[];
  photos: readonly Photo[];
}

export interface VerifyPayloadItem {
  id: Id;
  label: string;
  note: string | null;
}

export type VerifyState =
  | { phase: "load" }
  | { phase: "read"; payload: VerifyPayload }
  | { phase: "check"; payload: VerifyPayload; transcription: string }
  | { phase: "save"; payload: VerifyPayload; transcription: string; verdict: VerifyHomeworkResult };

export type VerifyTaskResult =
  | {
      status: "verified";
      verificationId: Id;
      model: string;
      findings: number;
      /** `true` when the verdict is the honest all-`unclear` fallback (SPEC §5.4). */
      degraded: boolean;
    }
  | {
      status: "duplicate";
      verificationId: Id;
      model: string;
    };

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Reads photo bytes; production wraps `data/photos`, tests inject bytes directly. */
export type PhotoBytesReader = (photo: Photo) => Promise<Uint8Array>;

export interface VerifyDeps {
  /** The three SPEC §7 clients; tests substitute a fake (no API key needed). */
  llm: LlmClients;
  /** Domain repositories (D2 in production, in-memory fakes in tests). */
  repos: Repos;
  logger?: Logger;
  /** Default: read `photosDir/photo.path` from disk. */
  readPhoto?: PhotoBytesReader;
  /** Root of the photo files (`Config.photosDir`). Default `data/photos` — boot wiring should pass it. */
  photosDir?: string;
}

/**
 * Filesystem reader for the photo root. `Config.photosDir` is the intended argument; the default
 * keeps tests and a bare local run working.
 */
export function createFsPhotoReader(photosDir = "data/photos"): PhotoBytesReader {
  return async (photo) => readFile(resolve(photosDir, photo.path));
}

const DEFAULT_LOGGER: Logger = createLogger({ bindings: { module: "verify" } });

// ---------------------------------------------------------------------------
// Task definition
// ---------------------------------------------------------------------------

/** Build the task for one dependency set. Registered by {@link createVerifyExtension}. */
export function createVerifyTask(deps: VerifyDeps) {
  const logger = deps.logger ?? DEFAULT_LOGGER;
  const readPhoto = deps.readPhoto ?? createFsPhotoReader(deps.photosDir);

  return defineTask<VerifyTaskInput, VerifyState, VerifyTaskResult>({
    name: VERIFY_TASK_NAME,
    version: VERIFY_TASK_VERSION,
    initial: () => ({ phase: "load" }),

    phases: {
      load: async (task, runtime, context) => {
        try {
          const { checkInId } = task.input;
          const checkIn = await deps.repos.checkIns.get(checkInId);
          if (checkIn === null) {
            await failPhase(runtime, context, `check-in ${checkInId} not found`);
            return;
          }

          // Idempotency: one analysis per check-in unless the caller explicitly recomputes.
          // `VerificationsRepo` has no "find by check-in exists" method; `latestForCheckIn` is the
          // closest contract operation (see the V2 report).
          const existing = await deps.repos.verifications.latestForCheckIn(checkInId);
          if (existing !== null && task.input.force !== true) {
            await completeDuplicate(runtime, context, existing);
            return;
          }

          const photos = await deps.repos.photos.listByCheckIn(checkInId);
          if (photos.length === 0) {
            await failPhase(runtime, context, `check-in ${checkInId} has no photos to read`);
            return;
          }

          const assignment = await deps.repos.assignments.getWithItems(checkIn.assignment_id);
          if (assignment === null) {
            await failPhase(runtime, context, `assignment ${checkIn.assignment_id} of check-in ${checkInId} not found`);
            return;
          }
          if (assignment.items.length === 0) {
            await failPhase(runtime, context, `assignment ${assignment.id} has no items to verify`);
            return;
          }

          const payload: VerifyPayload = {
            checkInId,
            assignmentId: assignment.id,
            childUserId: checkIn.child_user_id,
            assignmentText: describeAssignment(assignment),
            items: assignment.items.map((item) => ({ id: item.id, label: item.label, note: item.note })),
            photos,
          };

          logger.info("verify: loaded check-in", {
            checkInId,
            assignmentId: assignment.id,
            childUserId: payload.childUserId,
            photos: photos.length,
            items: payload.items.length,
          });
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "read", payload } }), context);
        } catch (error) {
          await failPhase(runtime, context, `verify load failed: ${errorMessage(error)}`);
        }
      },

      read: async (task, runtime, context) => {
        const { payload } = task.state.checkpoint;
        const prompt = `${READ_PROMPT}\n\nПункты задания: ${payload.items.map((item) => item.label).join("; ")}`;
        try {
          const photos: { bytes: Uint8Array; mime: string }[] = [];
          for (const photo of payload.photos) {
            photos.push({ bytes: await readPhoto(photo), mime: photo.mime });
          }
          const read = await deps.llm.readImages({ photos, prompt });
          logger.info("verify: photos transcribed", {
            checkInId: payload.checkInId,
            photos: photos.length,
            model: read.model,
            chars: read.text.length,
          });
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: { phase: "check", payload, transcription: read.text },
            }),
            context,
          );
        } catch (error) {
          await failPhase(runtime, context, `verify read failed: ${describeError(error)}`);
        }
      },

      check: async (task, runtime, context) => {
        const { payload, transcription } = task.state.checkpoint;
        try {
          const verdict = await deps.llm.verifyHomework({
            assignmentText: payload.assignmentText,
            items: payload.items.map((item) => ({ label: item.label, note: item.note })),
            studentSolutionText: transcription,
          });
          logger.info("verify: model verdict ready", {
            checkInId: payload.checkInId,
            model: verdict.model,
            degraded: verdict.degraded,
          });
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: { phase: "save", payload, transcription, verdict },
            }),
            context,
          );
        } catch (error) {
          await failPhase(runtime, context, `verify check failed: ${describeError(error)}`);
        }
      },

      save: async (task, runtime, context) => {
        const { payload, verdict } = task.state.checkpoint;
        try {
          // Race safety: another task may have saved between our load and now (tasks run
          // concurrently); a unique constraint would be stronger, but the repo contract has none.
          const existing = await deps.repos.verifications.latestForCheckIn(payload.checkInId);
          if (existing !== null && task.input.force !== true) {
            await completeDuplicate(runtime, context, existing);
            return;
          }

          const findings = mapFindings(payload.items, verdict.items);
          const verification = await deps.repos.verifications.createDraft({
            checkin_id: payload.checkInId,
            summary: verdict.summary,
            model: verdict.model,
            findings,
          });

          logger.info("verify: draft verification saved", {
            checkInId: payload.checkInId,
            verificationId: verification.id,
            findings: findings.length,
            degraded: verdict.degraded,
          });
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "completed",
                result: {
                  status: "verified",
                  verificationId: verification.id,
                  model: verdict.model,
                  findings: findings.length,
                  degraded: verdict.degraded,
                },
              },
            }),
            context,
          );
        } catch (error) {
          await failPhase(runtime, context, `verify save failed: ${describeError(error)}`);
        }
      },
    },

    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
}

/** The `hmwrk-verify` extension: registers the task. It has no tools and no prompt section. */
export function createVerifyExtension(deps: VerifyDeps, task = createVerifyTask(deps)): Extension {
  return defineExtension({
    name: VERIFY_EXTENSION_NAME,
    tasks: [task],
  });
}

// ---------------------------------------------------------------------------
// Spawner (A2 / I2 contract)
// ---------------------------------------------------------------------------

export interface VerifySpawnerOptions {
  /** Invocation context; default `BACKGROUND_CONTEXT`. */
  context?: Context;
  /** Conversation that owns the task. Default: the Harness root conversation (household-level work). */
  conversationId?: ConversationId;
}

/**
 * `VerifySpawner` over an open core (K9 creation pattern).
 *
 * The task object is taken from the installed registry: install {@link createVerifyExtension}
 * before calling this, otherwise the spawner cannot construct the task record. `resume()` is called
 * after the creation commit, so the task starts without the caller having to remember it.
 */
export function createVerifySpawner(core: Core, options: VerifySpawnerOptions = {}): VerifySpawner {
  const context = options.context ?? BACKGROUND_CONTEXT;

  const installed = registryFor(core).snapshot().task(VERIFY_TASK_NAME);
  if (installed === undefined) {
    throw new Error(
      `task ${VERIFY_TASK_NAME} is not registered; install createVerifyExtension() before createVerifySpawner()`,
    );
  }
  const task = installed as unknown as Task<VerifyTaskInput, VerifyState, VerifyTaskResult, object>;

  let owner: ConversationId | undefined = options.conversationId;

  async function ownerConversation(): Promise<ConversationId> {
    if (owner !== undefined) return owner;
    // The root conversation is the household scope: a check-in verification is not a chat turn
    // of one person, so it must not be owned by the child's conversation (an abort of that chat
    // would cascade into the verdict).
    const root = await core.harness.root(context);
    owner = root.id;
    return owner;
  }

  return {
    async startVerify(input: { checkInId: string }): Promise<{ taskId: string }> {
      const conversationId = await ownerConversation();
      const taskId = await core.harness.commit(
        (tx) =>
          tx.createTask(
            task,
            { checkInId: input.checkInId },
            { ownership: { kind: "conversation" }, conversationId },
          ),
        context,
      );
      core.harness.resume();
      return { taskId: String(taskId) };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function completeDuplicate(
  runtime: TaskRuntime<VerifyTaskInput, VerifyState, VerifyTaskResult, object>,
  context: Context,
  existing: VerificationWithFindings,
): Promise<void> {
  await runtime.commit(
    () => ({
      status: "terminal",
      outcome: {
        status: "completed",
        result: { status: "duplicate", verificationId: existing.id, model: existing.model },
      },
    }),
    context,
  );
}

async function failPhase(
  runtime: TaskRuntime<VerifyTaskInput, VerifyState, VerifyTaskResult, object>,
  context: Context,
  message: string,
): Promise<void> {
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "failed", error: { message } } }),
    context,
  );
}

/** Human/LLM-facing description of the assignment (the model never sees database ids). */
function describeAssignment(assignment: AssignmentWithItems): string {
  const lines = [`Предмет: ${assignment.subject}`, `Дедлайн: ${assignment.due_at}`];
  if (assignment.note !== null && assignment.note.trim() !== "") lines.push(`Заметка: ${assignment.note}`);
  return lines.join("\n");
}

/**
 * Verdict items are aligned by label because {@link VerifyHomeworkResult} copies labels from the
 * input (see `alignFindings`). Position is the primary key and label the fallback, so even a
 * partially malformed verdict cannot put a wrong item_id on a finding.
 */
function mapFindings(
  items: readonly VerifyPayloadItem[],
  verdictItems: VerifyHomeworkResult["items"],
): NewVerificationFindingInput[] {
  const byLabel = new Map<string, VerifyHomeworkResult["items"][number]>();
  for (const finding of verdictItems) {
    const key = labelKey(finding.label);
    if (!byLabel.has(key)) byLabel.set(key, finding);
  }

  return items.map((item, index) => {
    const positional = verdictItems[index];
    const match =
      positional !== undefined && labelKey(positional.label) === labelKey(item.label)
        ? positional
        : byLabel.get(labelKey(item.label));
    const verdict: FindingVerdict = match?.verdict ?? "unclear";
    return {
      item_id: item.id,
      verdict,
      comment:
        match === undefined
          ? "Модель не дала вердикт по этому пункту; проверьте вручную."
          : match.comment === "" ? null : match.comment,
    };
  });
}

function labelKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^№\s*/, "")
    .replace(/\s+/g, " ");
}

function describeError(error: unknown): string {
  if (error instanceof LlmError) return `[${error.code}] ${error.message}`;
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
