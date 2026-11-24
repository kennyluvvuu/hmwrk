/**
 * A2: the child's report and the two role views of verdicts — `submit_check_in`, `get_verdicts`.
 *
 * Covers SPEC §5.4's happy path (report → `in_review` → verify started) and the edges the status
 * machine and the role rules create: no photos, unknown assignment, already reported, already
 * done, verify start failing after the report is stored.
 */

import { describe, expect, it } from "vitest";
import { toIso } from "../../domain/dates.js";
import {
  CHILD_CONVERSATION,
  CHILD_USER_ID,
  createToolHarness,
  NOW,
  PARENT_CONVERSATION,
  resultText,
  seedAssignment,
  seedDraft,
  seedPhoto,
} from "./testing/harness.js";

describe("submit_check_in", () => {
  it("отчёт: задание → in_review, фото привязаны, проверка запущена", async () => {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos, { subject: "Математика" });
    const [first, second] = [await seedPhoto(harness.repos), await seedPhoto(harness.repos)];

    const result = await harness.call("submit_check_in", CHILD_CONVERSATION, {
      assignment_id: assignment.id,
      photo_ids: [first?.id, second?.id],
      comment: "№13 не уверен",
    });
    const text = resultText(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("Отчёт по «Математика» принят (2 фото)");
    expect(text).toContain("Комментарий записан: «№13 не уверен»");
    expect(text).toContain("Проверка запущена");

    const checkIn = harness.repos.raw.checkIns[0];
    expect(checkIn?.child_user_id).toBe(CHILD_USER_ID);
    expect(checkIn?.assignment_id).toBe(assignment.id);
    expect(checkIn?.comment).toBe("№13 не уверен");
    expect((await harness.repos.assignments.get(assignment.id))?.status).toBe("in_review");
    expect(await harness.repos.photos.listByCheckIn(checkIn?.id ?? "")).toHaveLength(2);
    expect(harness.verifyCalls).toEqual([{ checkInId: checkIn?.id }]);
    expect(text).toContain(checkIn?.id ?? "missing");
  });

  it("несуществующее фото — отчёт не создаётся, задание остаётся активным", async () => {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos);
    const result = await harness.call("submit_check_in", CHILD_CONVERSATION, {
      assignment_id: assignment.id,
      photo_ids: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Не нашёл фото");
    expect(harness.repos.raw.checkIns).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect((await harness.repos.assignments.get(assignment.id))?.status).toBe("active");
  });

  it("неизвестное задание — вежливый отказ с подсказкой", async () => {
    const harness = createToolHarness();
    const result = await harness.call("submit_check_in", CHILD_CONVERSATION, {
      assignment_id: "33333333-3333-4333-8333-333333333333",
      photo_ids: ["44444444-4444-4444-8444-444444444444"],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("list_assignments");
  });

  it("сданное задание не принимает отчёт", async () => {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos, { status: "done" });
    const photo = await seedPhoto(harness.repos);
    const result = await harness.call("submit_check_in", CHILD_CONVERSATION, {
      assignment_id: assignment.id,
      photo_ids: [photo.id],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("уже сдано");
    expect(harness.repos.raw.checkIns).toHaveLength(0);
  });

  it("задание на проверке не принимает второй отчёт", async () => {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos, { status: "in_review" });
    const photo = await seedPhoto(harness.repos);
    const result = await harness.call("submit_check_in", CHILD_CONVERSATION, {
      assignment_id: assignment.id,
      photo_ids: [photo.id],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("отчёт уже отправлен");
    expect(harness.repos.raw.checkIns).toHaveLength(0);
  });

  it("сбой запуска проверки не теряет отчёт", async () => {
    const harness = createToolHarness({
      startVerify: async () => {
        throw new Error("scheduler down");
      },
    });
    const assignment = await seedAssignment(harness.repos);
    const photo = await seedPhoto(harness.repos);
    const result = await harness.call("submit_check_in", CHILD_CONVERSATION, {
      assignment_id: assignment.id,
      photo_ids: [photo.id],
    });

    const text = resultText(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("Проверку запустить не удалось");
    expect(harness.repos.raw.checkIns).toHaveLength(1);
    expect((await harness.repos.assignments.get(assignment.id))?.status).toBe("in_review");
  });
});

describe("get_verdicts", () => {
  /** Assignment `in_review` with one draft and one approved verification of different check-ins. */
  async function seedTwoVerdicts() {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos, { subject: "Математика", status: "in_review" });
    const draft = await seedDraft(harness.repos, assignment.id, {
      summary: "№13 решён неверно.",
      verdicts: ["wrong", "unclear"],
    });
    const approved = await seedDraft(harness.repos, assignment.id, { summary: "Всё верно." });
    await harness.repos.verifications.decide(approved.verification.id, "approved", "u-parent", NOW);
    return { harness, assignment, draft, approved };
  }

  it("родитель видит все вердикты, включая черновики", async () => {
    const { harness, assignment, draft, approved } = await seedTwoVerdicts();
    const text = resultText(await harness.call("get_verdicts", PARENT_CONVERSATION, {}));
    expect(text).toContain("Вердикты (2)");
    expect(text).toContain(draft.verification.id);
    expect(text).toContain(approved.verification.id);
    expect(text).toContain("черновик");
    expect(text).toContain("№13 решён неверно.");
    expect(text).toContain(assignment.subject);
  });

  it("вердикты пунктов рендерятся по-русски и с метками пунктов", async () => {
    const { harness, draft } = await seedTwoVerdicts();
    const text = resultText(await harness.call("get_verdicts", PARENT_CONVERSATION, { status: "draft" }));
    expect(text).toContain("— №12: ошибка — «Решение верное»");
    expect(text).toContain("— №13: не разобрал");
    expect(text).toContain(draft.verification.id);
  });

  it("ребёнок видит только утверждённые, даже если просит draft", async () => {
    const { harness, assignment, draft, approved } = await seedTwoVerdicts();
    const askedAll = resultText(await harness.call("get_verdicts", CHILD_CONVERSATION, { status: "draft" }));
    expect(askedAll).toContain("Утверждённые вердикты (1)");
    expect(askedAll).toContain(approved.verification.id);
    expect(askedAll).not.toContain(draft.verification.id);
    expect(askedAll).toContain("Черновики ребёнку не показываются");

    const byAssignment = resultText(
      await harness.call("get_verdicts", CHILD_CONVERSATION, { assignment_id: assignment.id }),
    );
    expect(byAssignment).not.toContain(draft.verification.id);
  });

  it("неизвестное задание и пустой список — понятные ответы", async () => {
    const harness = createToolHarness();
    const unknown = await harness.call("get_verdicts", PARENT_CONVERSATION, {
      assignment_id: "55555555-5555-4555-8555-555555555555",
    });
    expect(resultText(unknown)).toContain("Не нашёл задание");

    expect(resultText(await harness.call("get_verdicts", CHILD_CONVERSATION, {}))).toContain(
      "Утверждённых вердиктов пока нет",
    );
    expect(resultText(await harness.call("get_verdicts", PARENT_CONVERSATION, {}))).toContain("Вердиктов нет");
  });

  it("дата решения видна в утверждённом вердикте", async () => {
    const { harness, approved } = await seedTwoVerdicts();
    const text = resultText(await harness.call("get_verdicts", PARENT_CONVERSATION, { status: "approved" }));
    expect(text).toContain(`решение: ${"24.11.2026 09:00"}`);
    expect(text).toContain(approved.verification.id);
  });
});

describe("терминальность вердиктов", () => {
  it("решение нельзя переписать", async () => {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos, { status: "in_review" });
    const { verification } = await seedDraft(harness.repos, assignment.id);
    await harness.repos.verifications.decide(verification.id, "approved", "u-parent", toIso(NOW));

    const result = await harness.call("dismiss_verification", PARENT_CONVERSATION, { verification_id: verification.id });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("уже решён");
    expect((await harness.repos.verifications.get(verification.id))?.status).toBe("approved");
  });
});
