/**
 * V2 durable verify-task tests: in-memory repositories + a fake LLM, a real Harness on temp SQLite.
 *
 * The LLM fake keeps the task tests deterministic and offline; the LLM layer itself is covered
 * against pi-ai's faux provider in `src/llm/llm.test.ts`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId, TaskOutcome } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHarness, type Core } from "../../contracts/harness.js";
import type { VerifySpawner } from "../../contracts/tasks.js";
import {
  createInMemoryRepos,
  type AssignmentWithItems,
  type CheckIn,
  type InMemoryRepos,
  type Repos,
} from "../../domain/index.js";
import {
  LlmError,
  type ChatResult,
  type LlmClients,
  type ReadImagesInput,
  type ReadImagesResult,
  type VerifyHomeworkInput,
  type VerifyHomeworkResult,
} from "../../llm/index.js";
import { fauxModels, makeTempDir, silentLogger, testConfig, type TempDir } from "../testkit.js";
import {
  createVerifyExtension,
  createVerifySpawner,
  type PhotoBytesReader,
  type VerifyTaskResult,
} from "./verify.js";

let temp: TempDir;
let core: Core | undefined;

beforeEach(() => {
  temp = makeTempDir("hmwrk-verify-");
});

afterEach(async () => {
  if (core !== undefined) {
    await core.close().catch(() => undefined);
    core = undefined;
  }
  temp.remove();
});

// ---------------------------------------------------------------------------
// Fakes and fixtures
// ---------------------------------------------------------------------------

interface FakeLlm {
  readonly clients: LlmClients;
  readonly readCalls: ReadImagesInput[];
  readonly verifyCalls: VerifyHomeworkInput[];
}

interface FakeLlmHandlers {
  read?: (input: ReadImagesInput) => Promise<ReadImagesResult>;
  verify?: (input: VerifyHomeworkInput) => Promise<VerifyHomeworkResult>;
}

function fakeLlm(handlers: FakeLlmHandlers = {}): FakeLlm {
  const readCalls: ReadImagesInput[] = [];
  const verifyCalls: VerifyHomeworkInput[] = [];

  const clients: LlmClients = {
    async readImages(input) {
      readCalls.push(input);
      if (handlers.read !== undefined) return handlers.read(input);
      return { text: "№ 12: 5 + 7 = 12\n№ 13: не решено", model: "read-fake" };
    },
    async verifyHomework(input) {
      verifyCalls.push(input);
      if (handlers.verify !== undefined) return handlers.verify(input);
      const items = input.items.map((item, index) => ({
        label: item.label,
        verdict: index === 0 ? ("ok" as const) : ("missing" as const),
        comment: index === 0 ? "верно" : "решения нет",
      }));
      return { items, summary: "№ 12 верно, № 13 не решено.", model: "verify-fake", degraded: false };
    },
    async chat(): Promise<ChatResult> {
      return { text: "ok", model: "chat-fake" };
    },
  };

  return { clients, readCalls, verifyCalls };
}

interface Seeded {
  assignment: AssignmentWithItems;
  checkIn: CheckIn;
}

async function seed(repos: Repos, options: { withPhoto?: boolean } = {}): Promise<Seeded> {
  const assignment = await repos.assignments.create({
    subject: "Математика",
    due_at: "2026-11-25T17:00:00.000Z",
    source: "manual",
    items: [{ label: "№ 12" }, { label: "№ 13" }],
  });
  const checkIn = await repos.checkIns.create({
    assignment_id: assignment.id,
    child_user_id: "child-1",
    comment: "сделал, но №13 не уверен",
  });
  if (options.withPhoto !== false) {
    const photo = await repos.photos.create({ kind: "checkin", path: "2026/11/notebook.jpg", mime: "image/jpeg" });
    await repos.photos.attachToCheckIn(checkIn.id, photo.id);
  }
  return { assignment, checkIn };
}

async function openCore(repos: Repos, llm: LlmClients, readPhoto: PhotoBytesReader): Promise<Core> {
  const logger = silentLogger();
  core = await openHarness(testConfig(temp.dir), {
    models: fauxModels().models,
    extensions: [createVerifyExtension({ llm, repos, logger, readPhoto })],
    logger,
  });
  await core.resume();
  return core;
}

async function runVerify(core: Core, spawner: VerifySpawner, checkInId: string) {
  const { taskId } = await spawner.startVerify({ checkInId });
  const settled = await core.harness.waitForTask<VerifyTaskResult>(
    Number(taskId) as TaskId<VerifyTaskResult>,
    BACKGROUND_CONTEXT,
  );
  return settled.state.outcome;
}

function completed(outcome: TaskOutcome<VerifyTaskResult>): Extract<TaskOutcome<VerifyTaskResult>, { status: "completed" }> {
  if (outcome.status !== "completed") {
    throw new Error(`expected completed, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function failed(outcome: TaskOutcome<VerifyTaskResult>): string {
  if (outcome.status !== "failed") {
    throw new Error(`expected failed, got ${JSON.stringify(outcome)}`);
  }
  return outcome.error.message;
}

const photoReader = (calls: string[]): PhotoBytesReader => async (photo) => {
  calls.push(photo.path);
  return new Uint8Array([1, 2, 3, 4]);
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("hmwrk.verify", () => {
  it("reads photos, grades items and stores a draft verification with findings", async () => {
    const repos: InMemoryRepos = createInMemoryRepos();
    const used = await seed(repos);
    const llm = fakeLlm();
    const readPhotoCalls: string[] = [];
    const opened = await openCore(repos, llm.clients, photoReader(readPhotoCalls));
    const spawner = createVerifySpawner(opened);

    const outcome = completed(await runVerify(opened, spawner, used.checkIn.id));

    expect(outcome.result).toMatchObject({
      status: "verified",
      model: "verify-fake",
      findings: 2,
      degraded: false,
    });

    // Photo bytes came through the reader once, for the attached photo.
    expect(readPhotoCalls).toEqual(["2026/11/notebook.jpg"]);
    expect(llm.readCalls).toHaveLength(1);
    expect(llm.readCalls[0]?.photos).toHaveLength(1);
    expect(llm.readCalls[0]?.prompt).toContain("№ 12");

    // The check stage saw the transcription and the item labels, not database ids.
    expect(llm.verifyCalls).toHaveLength(1);
    expect(llm.verifyCalls[0]?.studentSolutionText).toContain("5 + 7");
    expect(llm.verifyCalls[0]?.items.map((item) => item.label)).toEqual(["№ 12", "№ 13"]);

    // One draft verification with findings mapped to the real item ids.
    const verifications = await repos.verifications.listByCheckIn(used.checkIn.id);
    expect(verifications).toHaveLength(1);
    expect(verifications[0]).toMatchObject({ status: "draft", model: "verify-fake" });
    expect(verifications[0]?.decided_at).toBeNull();

    const verification = verifications[0];
    if (verification === undefined) throw new Error("verification missing");
    const findings = await repos.verifications.findings(verification.id);
    expect(findings.map((finding) => [finding.item_id, finding.verdict])).toEqual([
      [used.assignment.items[0]?.id, "ok"],
      [used.assignment.items[1]?.id, "missing"],
    ]);

    // The task must not touch the assignment status: approval is the parent's (I2).
    expect((await repos.assignments.get(used.assignment.id))?.status).toBe("active");
  });

  it("does not analyse the same check-in twice (idempotent rerun)", async () => {
    const repos = createInMemoryRepos();
    const used = await seed(repos);
    const llm = fakeLlm();
    const opened = await openCore(repos, llm.clients, photoReader([]));
    const spawner = createVerifySpawner(opened);

    const first = completed(await runVerify(opened, spawner, used.checkIn.id));
    const second = completed(await runVerify(opened, spawner, used.checkIn.id));

    expect(first.result.status).toBe("verified");
    expect(second.result).toMatchObject({ status: "duplicate", model: "verify-fake" });
    expect(await repos.verifications.listByCheckIn(used.checkIn.id)).toHaveLength(1);
    // No second model call: the duplicate was detected in `load`, before any spend.
    expect(llm.readCalls).toHaveLength(1);
    expect(llm.verifyCalls).toHaveLength(1);
  });

  it("still stores an honest all-unclear verdict when the model degraded", async () => {
    const repos = createInMemoryRepos();
    const used = await seed(repos);
    const llm = fakeLlm({
      verify: async (input) => ({
        items: input.items.map((item) => ({
          label: item.label,
          verdict: "unclear" as const,
          comment: "не удалось разобрать ответ модели",
        })),
        summary: "Автоматическая проверка не удалась.",
        model: "verify-fake",
        degraded: true,
      }),
    });
    const opened = await openCore(repos, llm.clients, photoReader([]));
    const spawner = createVerifySpawner(opened);

    const outcome = completed(await runVerify(opened, spawner, used.checkIn.id));

    expect(outcome.result).toMatchObject({ status: "verified", degraded: true });
    const [verification] = await repos.verifications.listByCheckIn(used.checkIn.id);
    if (verification === undefined) throw new Error("verification missing");
    expect((await repos.verifications.findings(verification.id)).map((finding) => finding.verdict)).toEqual([
      "unclear",
      "unclear",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("hmwrk.verify failures", () => {
  it("fails when the check-in has no photos", async () => {
    const repos = createInMemoryRepos();
    const used = await seed(repos, { withPhoto: false });
    const llm = fakeLlm();
    const opened = await openCore(repos, llm.clients, photoReader([]));
    const spawner = createVerifySpawner(opened);

    const message = failed(await runVerify(opened, spawner, used.checkIn.id));

    expect(message).toContain("no photos");
    expect(llm.readCalls).toHaveLength(0);
    expect(await repos.verifications.listByCheckIn(used.checkIn.id)).toHaveLength(0);
  });

  it("fails for an unknown check-in", async () => {
    const repos = createInMemoryRepos();
    const llm = fakeLlm();
    const opened = await openCore(repos, llm.clients, photoReader([]));
    const spawner = createVerifySpawner(opened);

    const message = failed(await runVerify(opened, spawner, "does-not-exist"));

    expect(message).toContain("not found");
    expect(llm.readCalls).toHaveLength(0);
  });

  it("fails with the LLM error code when photo reading fails", async () => {
    const repos = createInMemoryRepos();
    const used = await seed(repos);
    const llm = fakeLlm({
      read: async () => {
        throw new LlmError("request_failed", "vision provider is down", "read");
      },
    });
    const opened = await openCore(repos, llm.clients, photoReader([]));
    const spawner = createVerifySpawner(opened);

    const message = failed(await runVerify(opened, spawner, used.checkIn.id));

    expect(message).toContain("[request_failed]");
    expect(message).toContain("vision provider is down");
    // The verify stage is never reached, and nothing is stored.
    expect(llm.verifyCalls).toHaveLength(0);
    expect(await repos.verifications.listByCheckIn(used.checkIn.id)).toHaveLength(0);
  });
});
