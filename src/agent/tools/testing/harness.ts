/**
 * Test harness for the nine tools: fakes only, no pi-durable harness, no SQLite.
 *
 * One `createToolHarness()` gives the whole rig a tool test needs:
 *
 * - {@link InMemoryRepos} from `src/domain/fakes.ts` (T1's contracts, D2's semantics), with a
 *   controllable clock — «просрочено» and `decided_at` are clock-dependent, so tests pin it;
 * - a fake {@link VerifySpawner} that records `checkInId`s, and can be made to fail (a lost start
 *   must not lose the report);
 * - the real {@link createHmwrkTools} toolset, so gating and validation are exercised as wired;
 * - {@link ToolHarness.call}, which invokes a tool the way the Harness does: raw arguments plus
 *   `api.conversationId` — the role never travels in the arguments.
 *
 * P1 adds the intake half of `parse_screenshot`: pass `visionAnswer` (a scripted read-model answer)
 * or `readImages` (a real client over a faux provider) to enable the seam, then
 * {@link ToolHarness.seedScreenshot} to create the photo row and its bytes.
 *
 * Not named `*.test.ts` on purpose: it is support code, imported by several test files.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ConversationId, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ActorDirectory, AgentToolset } from "../../../contracts/index.js";
import type { ToolDeps, VerifySpawner } from "../../../contracts/tasks.js";
import { addLocalDays, atLocalTime, toIso } from "../../../domain/dates.js";
import { createInMemoryRepos } from "../../../domain/fakes.js";
import type { InMemoryRepos } from "../../../domain/fakes.js";
import type {
  AssignmentStatus,
  AssignmentWithItems,
  CheckIn,
  FindingVerdict,
  Photo,
  Repos,
  Settings,
  ToolName,
  VerificationWithFindings,
} from "../../../domain/index.js";
import type { ReadImagesInput, ReadImagesResult } from "../../../llm/index.js";
import { createHmwrkTools } from "../index.js";
import type { ScreenshotIntake } from "../screenshot-draft.js";

/** K3 conversations: parent, child, and one nobody mapped (the least-privilege path). */
export const PARENT_CONVERSATION = 1 as ConversationId;
export const CHILD_CONVERSATION = 2 as ConversationId;
export const UNKNOWN_CONVERSATION = 3 as ConversationId;

export const PARENT_USER_ID = "u-parent";
export const CHILD_USER_ID = "u-child";

/** Local Tuesday, 24 November 2026, 09:00 — the household clock tests pin. */
export const NOW = new Date(2026, 10, 24, 9, 0, 0);

/** `25.11.2026 20:00` local — what `settings.default_due` produces from {@link NOW}. */
export const DEFAULT_DUE_INSTANT = atLocalTime(addLocalDays(NOW, 1), "20:00");

const actors: ActorDirectory = {
  async get(conversationId) {
    if (conversationId === PARENT_CONVERSATION) return { userId: PARENT_USER_ID, role: "parent" };
    if (conversationId === CHILD_CONVERSATION) return { userId: CHILD_USER_ID, role: "child" };
    return null;
  },
};

export interface ToolHarnessOptions {
  /** Initial clock instant; default {@link NOW}. */
  readonly now?: Date;
  /** Stored settings overrides (defaults come from `src/domain/settings.ts`). */
  readonly settings?: Partial<Settings>;
  /** Replace the verify start — e.g. to make it throw. Called after the id is recorded. */
  readonly startVerify?: VerifySpawner["startVerify"];
  /**
   * One scripted vision answer for `parse_screenshot` (P1). Enables the intake seam with a fake
   * read client; a function receives the prompt/photos and may answer differently per call (the
   * corrective-retry cases do exactly that).
   */
  readonly visionAnswer?: string | ((input: ReadImagesInput) => string | Promise<string>);
  /** A real read client (e.g. `createLlmClients` over a faux provider); wins over `visionAnswer`. */
  readonly readImages?: ScreenshotIntake["readImages"];
}

export interface ToolHarness {
  readonly repos: InMemoryRepos;
  readonly tools: AgentToolset;
  /** `checkInId`s the tools asked to verify, in call order. */
  readonly verifyCalls: readonly { checkInId: string }[];
  /** Every `readImages` input of `parse_screenshot`, in call order. */
  readonly readCalls: readonly ReadImagesInput[];
  now(): Date;
  setNow(value: Date): void;
  /** Create a `screenshot` photo row and register its bytes for the intake seam. */
  seedScreenshot(bytes?: Uint8Array): Promise<Photo>;
  /** Invoke a tool exactly as `execute(args, api, context)` does. */
  call(name: ToolName, conversation: ConversationId, args: unknown): Promise<ToolExecutionResult>;
}

/** Bytes the fake store answers with when a screenshot was seeded without explicit ones. */
const FAKE_SCREENSHOT_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);

export function createToolHarness(options: ToolHarnessOptions = {}): ToolHarness {
  let instant = options.now ?? NOW;
  const now = (): Date => instant;

  const repos = createInMemoryRepos({ now, ...(options.settings === undefined ? {} : { settings: options.settings }) });

  const verifyCalls: { checkInId: string }[] = [];
  const spawnVerify: VerifySpawner = {
    async startVerify(input) {
      verifyCalls.push({ ...input });
      if (options.startVerify !== undefined) return options.startVerify(input);
      return { taskId: `task-${verifyCalls.length}` };
    },
  };

  const deps: ToolDeps = { repos, spawnVerify, now };

  const readCalls: ReadImagesInput[] = [];
  const photoBytes = new Map<string, Uint8Array>();
  const visionAnswer = options.visionAnswer;
  const intake: ScreenshotIntake | undefined =
    options.readImages === undefined && visionAnswer === undefined
      ? undefined
      : {
          readImages: async (input): Promise<ReadImagesResult> => {
            readCalls.push(input);
            if (options.readImages !== undefined) return options.readImages(input);
            const text = typeof visionAnswer === "function" ? await visionAnswer(input) : (visionAnswer ?? "");
            return { text, model: "faux-read" };
          },
          photoFiles: {
            async read(photo) {
              const bytes = photoBytes.get(photo.id);
              if (bytes === undefined) throw new Error(`photo file ${photo.path} is missing on disk`);
              return bytes;
            },
          },
        };

  const tools = createHmwrkTools(deps, actors, intake === undefined ? {} : { intake });

  return {
    repos,
    tools,
    verifyCalls,
    readCalls,
    now,
    setNow(value) {
      instant = value;
    },
    async seedScreenshot(bytes = FAKE_SCREENSHOT_BYTES) {
      const photo = await repos.photos.create({ kind: "screenshot", path: `${Math.random().toString(16).slice(2)}.jpg`, mime: "image/jpeg" });
      photoBytes.set(photo.id, bytes);
      return photo;
    },
    async call(name, conversation, args) {
      const tool = tools[name];
      if (tool === undefined) throw new Error(`Tool ${name} is not registered`);
      const api = { conversationId: conversation } as unknown as ToolExecutionApi;
      // Our nine tools never park (they do all their work in one pass), so a result is a result.
      return (await tool.execute(args as never, api, BACKGROUND_CONTEXT)) as ToolExecutionResult;
    },
  };
}

/** Model-visible text of a tool result. */
export function resultText(result: ToolExecutionResult): string {
  const content = result.output ?? [];
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export interface SeedAssignmentOptions {
  readonly subject?: string;
  /** Due instant; default tomorrow 20:00 local (the SPEC §5.7 default). */
  readonly due?: Date;
  readonly items?: readonly string[];
  readonly note?: string | null;
  /** Force a stored status after creation (for `done` / `in_review` fixtures). */
  readonly status?: AssignmentStatus;
}

/** An assignment with items, created through the fake repository like the intake does. */
export async function seedAssignment(
  repos: Repos,
  options: SeedAssignmentOptions = {},
): Promise<AssignmentWithItems> {
  const created = await repos.assignments.create({
    subject: options.subject ?? "Математика",
    due_at: toIso(options.due ?? DEFAULT_DUE_INSTANT),
    source: "manual",
    note: options.note ?? null,
    items: (options.items ?? ["№12", "№13"]).map((label) => ({ label })),
  });
  if (options.status === undefined || options.status === "active") return created;
  const updated = await repos.assignments.setStatus(created.id, options.status);
  return { ...updated, items: created.items };
}

/** A notebook photo, as the intake would have stored it (P1 writes the file, we store metadata). */
export async function seedPhoto(repos: Repos, kind: "checkin" | "screenshot" = "checkin") {
  return repos.photos.create({ kind, path: `2026/11/${kind}-${Math.random().toString(16).slice(2)}.jpg`, mime: "image/jpeg" });
}

export interface SeedDraftOptions {
  readonly summary?: string;
  readonly model?: string;
  /** Verdict per item, in item order; default `ok` for every item. */
  readonly verdicts?: readonly FindingVerdict[];
  /** Comment of the first finding; default «Решение верное». */
  readonly comment?: string | null;
  readonly childUserId?: string;
  readonly comment_on_checkin?: string | null;
}

/**
 * A check-in with a draft verification — what V2's verify task leaves behind (SPEC §5.4).
 * The assignment status is not touched here: the real flow sets `in_review` in `submit_check_in`.
 */
export async function seedDraft(
  repos: Repos,
  assignmentId: string,
  options: SeedDraftOptions = {},
): Promise<{ checkIn: CheckIn; verification: VerificationWithFindings }> {
  const checkIn = await repos.checkIns.create({
    assignment_id: assignmentId,
    child_user_id: options.childUserId ?? CHILD_USER_ID,
    comment: options.comment_on_checkin ?? null,
  });
  const items = await repos.assignments.listItems(assignmentId);
  const verification = await repos.verifications.createDraft({
    checkin_id: checkIn.id,
    summary: options.summary ?? "Все пункты выполнены верно.",
    model: options.model ?? "deepseek-v4-1-flash-1017",
    findings: items.map((item, index) => ({
      item_id: item.id,
      verdict: options.verdicts?.[index] ?? "ok",
      comment: index === 0 ? (options.comment === undefined ? "Решение верное" : options.comment) : null,
    })),
  });
  return { checkIn, verification };
}
