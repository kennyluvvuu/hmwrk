/**
 * A2: parent decisions and settings — `approve_verification`, `dismiss_verification`,
 * `get_settings`, `set_setting`.
 *
 * The transitions asserted here are the ones the journal fixed (plan §7, W1): approve →
 * `in_review → done`, dismiss → `in_review → active` (the report stays, the assignment returns to
 * the reminder loop), settings are parent-only and validated before they reach the store.
 */

import { describe, expect, it } from "vitest";
import { formatIsoDate, toIso } from "../../domain/dates.js";
import {
  createToolHarness,
  NOW,
  PARENT_CONVERSATION,
  PARENT_USER_ID,
  resultText,
  seedAssignment,
  seedDraft,
} from "./testing/harness.js";

describe("approve_verification", () => {
  it("draft → approved, задание → done, решение приписано родителю", async () => {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos, { subject: "Математика", status: "in_review" });
    const { verification } = await seedDraft(harness.repos, assignment.id);

    const result = await harness.call("approve_verification", PARENT_CONVERSATION, {
      verification_id: verification.id,
    });
    const text = resultText(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("Вердикт утверждён: «Математика» — сдано");
    expect(text).toContain("Ребёнок теперь увидит вердикт");

    const decided = await harness.repos.verifications.get(verification.id);
    expect(decided?.status).toBe("approved");
    expect(decided?.decided_by_user_id).toBe(PARENT_USER_ID);
    expect(decided?.decided_at).toBe(toIso(NOW));
    expect((await harness.repos.assignments.get(assignment.id))?.status).toBe("done");
  });

  it("второй раз утвердить нельзя — состояние не переписывается", async () => {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos, { status: "in_review" });
    const { verification } = await seedDraft(harness.repos, assignment.id);
    await harness.call("approve_verification", PARENT_CONVERSATION, { verification_id: verification.id });

    const again = await harness.call("approve_verification", PARENT_CONVERSATION, { verification_id: verification.id });
    expect(again.isError).toBe(true);
    expect(resultText(again)).toContain("уже решён");
    expect((await harness.repos.verifications.get(verification.id))?.status).toBe("approved");
  });

  it("неизвестный id — отказ без изменений", async () => {
    const harness = createToolHarness();
    const result = await harness.call("approve_verification", PARENT_CONVERSATION, {
      verification_id: "66666666-6666-4666-8666-666666666666",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Не нашёл вердикт");
    expect(harness.repos.raw.verifications).toHaveLength(0);
  });
});

describe("dismiss_verification", () => {
  it("draft → dismissed, задание возвращается в работу (active), причина повторена", async () => {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos, { subject: "Физика", status: "in_review" });
    const { checkIn, verification } = await seedDraft(harness.repos, assignment.id);

    const result = await harness.call("dismiss_verification", PARENT_CONVERSATION, {
      verification_id: verification.id,
      reason: "№2 решён верно, модель ошиблась",
    });
    const text = resultText(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("Вердикт отклонён: «Физика» снова ждёт отчёта");
    expect(text).toContain("Отчёт сохранён");
    expect(text).toContain("№2 решён верно, модель ошиблась");

    expect((await harness.repos.verifications.get(verification.id))?.status).toBe("dismissed");
    expect((await harness.repos.verifications.get(verification.id))?.decided_by_user_id).toBe(PARENT_USER_ID);
    expect((await harness.repos.assignments.get(assignment.id))?.status).toBe("active");
    // The report is not deleted: the child may add photos and report again.
    expect(await harness.repos.checkIns.get(checkIn.id)).not.toBeNull();
  });

  it("устаревший черновик не ломает статус задания", async () => {
    const harness = createToolHarness();
    const assignment = await seedAssignment(harness.repos, { status: "active" });
    const { verification } = await seedDraft(harness.repos, assignment.id);

    const result = await harness.call("dismiss_verification", PARENT_CONVERSATION, { verification_id: verification.id });
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("переход не нужен");
    expect((await harness.repos.verifications.get(verification.id))?.status).toBe("dismissed");
    expect((await harness.repos.assignments.get(assignment.id))?.status).toBe("active");
  });
});

describe("get_settings", () => {
  it("показывает действующие значения по умолчанию", async () => {
    const harness = createToolHarness();
    const text = resultText(await harness.call("get_settings", PARENT_CONVERSATION, {}));
    expect(text).toContain("reminder_time — напоминание ребёнку: 19:00");
    expect(text).toContain("digest_time — дайджест родителю: 21:00");
    expect(text).toContain("default_due — дедлайн по умолчанию: завтра 20:00");
    expect(text).toContain("paused_until — пауза рассылок: нет");
    expect(text).toContain("Сейчас рассылки идут");
  });

  it("видит паузу: сегодняшняя дата глушит рассылки", async () => {
    const harness = createToolHarness({ settings: { paused_until: formatIsoDate(NOW) } });
    const text = resultText(await harness.call("get_settings", PARENT_CONVERSATION, {}));
    expect(text).toContain("по 24.11.2026 включительно");
    expect(text).toContain("Сейчас рассылки на паузе");
  });

  it("прошедшая пауза не считается паузой", async () => {
    const harness = createToolHarness({ settings: { paused_until: "2026-01-09" } });
    const text = resultText(await harness.call("get_settings", PARENT_CONVERSATION, {}));
    expect(text).toContain("уже прошла");
    expect(text).toContain("Сейчас рассылки идут");
  });
});

describe("set_setting", () => {
  it("время нормализуется и показывается как «было → стало»", async () => {
    const harness = createToolHarness();
    const text = resultText(
      await harness.call("set_setting", PARENT_CONVERSATION, { key: "reminder_time", value: "20:30" }),
    );
    expect(text).toContain("reminder_time изменена: 19:00 → 20:30");
    expect(text).toContain("к следующим напоминаниям");
    expect(await harness.repos.settings.get("reminder_time")).toBe("20:30");
  });

  it("I3: смена времени рассылки пересобирает расписание, остальные ключи — нет", async () => {
    const harness = createToolHarness({ onScheduleSettingsChanged: () => undefined });

    const reminder = resultText(
      await harness.call("set_setting", PARENT_CONVERSATION, { key: "reminder_time", value: "20:30" }),
    );
    expect(reminder).toContain("Расписание напоминаний пересобрано");

    const digest = resultText(
      await harness.call("set_setting", PARENT_CONVERSATION, { key: "digest_time", value: "21:15" }),
    );
    expect(digest).toContain("Расписание дайджеста пересобрано");

    await harness.call("set_setting", PARENT_CONVERSATION, { key: "paused_until", value: "2026-12-31" });
    await harness.call("set_setting", PARENT_CONVERSATION, { key: "default_due", value: "20:00 след. дня" });

    // Only the two broadcast times re-plan the durable tasks: a pause is read at fire time, and a
    // default deadline never touches the schedule at all.
    expect(harness.scheduleCalls).toEqual(["reminder_time", "digest_time"]);
  });

  it("I3: сломанный хук не ломает сохранение настройки", async () => {
    const harness = createToolHarness({
      onScheduleSettingsChanged: () => {
        throw new Error("scheduler is down");
      },
    });

    const result = await harness.call("set_setting", PARENT_CONVERSATION, { key: "reminder_time", value: "20:30" });

    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("20:30");
    expect(resultText(result)).toContain("к следующим напоминаниям");
    expect(await harness.repos.settings.get("reminder_time")).toBe("20:30");
  });

  it("default_due принимает человеческую форму из SPEC §5.7", async () => {
    const harness = createToolHarness();
    const text = resultText(
      await harness.call("set_setting", PARENT_CONVERSATION, { key: "default_due", value: "20:00 след. дня" }),
    );
    expect(text).toContain("завтра 20:00 → завтра 20:00");
    expect(await harness.repos.settings.get("default_due")).toEqual({ offset_days: 1, time: "20:00" });

    await harness.call("set_setting", PARENT_CONVERSATION, {
      key: "default_due",
      value: { offset_days: 2, time: "18:30" },
    });
    expect(await harness.repos.settings.get("default_due")).toEqual({ offset_days: 2, time: "18:30" });
  });

  it("paused_until ставится и снимается", async () => {
    const harness = createToolHarness();
    const set = resultText(
      await harness.call("set_setting", PARENT_CONVERSATION, { key: "paused_until", value: "2026-12-31" }),
    );
    expect(set).toContain("до 31.12.2026 включительно");
    expect(set).toContain("молчат до конца этого дня");
    expect(await harness.repos.settings.get("paused_until")).toBe("2026-12-31");

    const cleared = resultText(
      await harness.call("set_setting", PARENT_CONVERSATION, { key: "paused_until", value: null }),
    );
    expect(cleared).toContain("паузы нет");
    expect(cleared).toContain("Рассылки снова идут");
    expect(await harness.repos.settings.get("paused_until")).toBeNull();
  });

  it("недопустимое значение — отказ с подсказкой, стор не тронут", async () => {
    const harness = createToolHarness();
    const result = await harness.call("set_setting", PARENT_CONVERSATION, { key: "reminder_time", value: "25:00" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("время должно быть в формате ЧЧ:ММ");
    expect(resultText(result)).toContain("Ничего не изменено");
    expect(harness.repos.raw.settings).toEqual({});
  });

  it("неизвестный ключ отклоняется схемой", async () => {
    const harness = createToolHarness();
    const result = await harness.call("set_setting", PARENT_CONVERSATION, { key: "school_day", value: "x" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Не понял аргументы");
  });
});
