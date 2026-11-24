/**
 * A2: intake and listing — `list_assignments`, `parse_screenshot`, `manual_add_assignment`.
 *
 * Statuses here follow SPEC §5.1: three stored ones plus the derived `overdue`; the due rule
 * follows SPEC §5.7 (default «завтра 20:00», overridable by `default_due`).
 */

import { describe, expect, it } from "vitest";
import { addLocalDays, atLocalTime, toIso } from "../../domain/dates.js";
import {
  CHILD_CONVERSATION,
  createToolHarness,
  DEFAULT_DUE_INSTANT,
  NOW,
  PARENT_CONVERSATION,
  resultText,
  seedAssignment,
} from "./testing/harness.js";

const yesterdayAt20 = atLocalTime(addLocalDays(NOW, -1), "20:00");
const todayAt18 = atLocalTime(NOW, "18:00");

describe("list_assignments", () => {
  /** One fixture per status, deliberately out of due order at insertion time. */
  async function seedMixed() {
    const harness = createToolHarness();
    const active = await seedAssignment(harness.repos, { subject: "Математика", due: DEFAULT_DUE_INSTANT, items: ["№12", "№13"] });
    const overdue = await seedAssignment(harness.repos, { subject: "Английский", due: yesterdayAt20 });
    const review = await seedAssignment(harness.repos, { subject: "История", due: todayAt18, status: "in_review" });
    const done = await seedAssignment(harness.repos, {
      subject: "Литература",
      due: yesterdayAt20,
      status: "done",
    });
    return { harness, active, overdue, review, done };
  }

  it("по умолчанию — активные (ждёт отчёта и на проверке) по возрастанию дедлайна", async () => {
    const { harness, active, overdue, review, done } = await seedMixed();
    const text = resultText(await harness.call("list_assignments", PARENT_CONVERSATION, {}));

    expect(text).toContain("Задания (3 из 3)");
    expect(text.indexOf("Английский")).toBeLessThan(text.indexOf("История"));
    expect(text.indexOf("История")).toBeLessThan(text.indexOf("Математика"));
    expect(text).toContain(active.id);
    expect(text).toContain(review.id);
    expect(text).toContain(overdue.id);
    expect(text).not.toContain(done.id);
    expect(text).toContain("на проверке");
    expect(text).toContain("ждёт отчёта");
    expect(text).toContain("просрочено");
    expect(text).toContain("пункты: №12, №13");
  });

  it("overdue — производное состояние: только active с прошедшим дедлайном", async () => {
    const { harness, overdue } = await seedMixed();
    const text = resultText(await harness.call("list_assignments", PARENT_CONVERSATION, { status: "overdue" }));
    expect(text).toContain("Английский");
    expect(text).toContain(overdue.id);
    expect(text).not.toContain("История");
    expect(text).not.toContain("Математика");
  });

  it("родитель может посмотреть историю: all и done", async () => {
    const { harness, done } = await seedMixed();
    const all = resultText(await harness.call("list_assignments", PARENT_CONVERSATION, { status: "all" }));
    expect(all).toContain("Задания (4 из 4)");
    expect(all).toContain("сдано");

    const onlyDone = resultText(await harness.call("list_assignments", PARENT_CONVERSATION, { status: "done" }));
    expect(onlyDone).toContain("Литература");
    expect(onlyDone).toContain(done.id);
  });

  it("ребёнок видит текущие задания; история не расширяется аргументом", async () => {
    const { harness, done } = await seedMixed();
    const text = resultText(await harness.call("list_assignments", CHILD_CONVERSATION, { status: "all" }));
    expect(text).toContain("Ребёнку показываются текущие задания");
    expect(text).not.toContain(done.id);
    expect(text).not.toContain("Литература");
  });

  it("subject фильтрует без учёта регистра", async () => {
    const { harness } = await seedMixed();
    const text = resultText(await harness.call("list_assignments", PARENT_CONVERSATION, { subject: "  математика " }));
    expect(text).toContain("Математика");
    expect(text).not.toContain("История");
  });

  it("limit режет ответ и честно об этом говорит", async () => {
    const { harness } = await seedMixed();
    const text = resultText(await harness.call("list_assignments", PARENT_CONVERSATION, { limit: 1 }));
    expect(text).toContain("Задания (1 из 3)");
    expect(text).toContain("Показал первые 1");
  });

  it("пустые ответы — тоже ответ", async () => {
    const harness = createToolHarness();
    expect(resultText(await harness.call("list_assignments", PARENT_CONVERSATION, {}))).toContain("Заданий нет");
    expect(resultText(await harness.call("list_assignments", PARENT_CONVERSATION, { status: "overdue" }))).toContain(
      "Просроченных заданий нет",
    );
  });
});

describe("parse_screenshot (заглушка M1)", () => {
  it("говорит про веху 3 и повторяет, что получил, не выдумывая задания", async () => {
    const harness = createToolHarness();
    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, {
      photo_ids: ["11111111-1111-4111-8111-111111111111"],
      hint: "дневник, математика №12",
    });
    const text = resultText(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("веха 3");
    expect(text).toContain("11111111-1111-4111-8111-111111111111");
    expect(text).toContain("дневник, математика №12");
    expect(text).toContain("manual_add_assignment");
    expect(harness.repos.raw.assignments).toHaveLength(0);
  });

  it("работает и по одной текстовой подсказке", async () => {
    const harness = createToolHarness();
    const text = resultText(await harness.call("parse_screenshot", PARENT_CONVERSATION, { hint: "чтение, стр. 12" }));
    expect(text).toContain("чтение, стр. 12");
    expect(text).toContain("ещё не подключён");
  });
});

describe("manual_add_assignment", () => {
  it("без дат берёт дедлайн из default_due (завтра 20:00)", async () => {
    const harness = createToolHarness();
    const result = await harness.call("manual_add_assignment", PARENT_CONVERSATION, {
      subject: " Математика ",
      items: ["№12", { label: " №13 ", note: "со звёздочкой" }],
      note: "на пятницу",
    });

    const text = resultText(result);
    expect(result.isError).toBeUndefined();
    expect(text).toContain("«Математика»");
    expect(text).toContain("к 25.11.2026 20:00");
    expect(text).toContain("дедлайн по умолчанию — завтра 20:00");
    expect(text).toContain("Пункты (2 пункта): №12, №13");
    expect(text).toContain("Заметка: на пятницу");

    const stored = harness.repos.raw.assignments[0];
    expect(stored?.due_at).toBe(toIso(DEFAULT_DUE_INSTANT));
    expect(stored?.source).toBe("manual");
    expect(stored?.status).toBe("active");
    expect(harness.repos.raw.items.map((item) => item.label)).toEqual(["№12", "№13"]);
    expect(harness.repos.raw.items[1]?.note).toBe("со звёздочкой");
    expect(text).toContain(stored?.id ?? "missing");
  });

  it("due_date → этот день в default_due.time", async () => {
    const harness = createToolHarness();
    await harness.call("manual_add_assignment", PARENT_CONVERSATION, {
      subject: "Физика",
      items: ["№1"],
      due_date: "2026-11-30",
    });
    expect(harness.repos.raw.assignments[0]?.due_at).toBe(toIso(new Date(2026, 10, 30, 20, 0, 0, 0)));
  });

  it("due_at принимается как есть; прошедший дедлайн помечается", async () => {
    const harness = createToolHarness();
    const past = new Date(2026, 10, 23, 18, 0, 0, 0);
    const text = resultText(
      await harness.call("manual_add_assignment", PARENT_CONVERSATION, {
        subject: "Геометрия",
        items: ["№7"],
        due_at: past.toISOString(),
      }),
    );
    expect(harness.repos.raw.assignments[0]?.due_at).toBe(past.toISOString());
    expect(text).toContain("Дедлайн уже прошёл");
  });

  it("учитывает изменённую настройку default_due", async () => {
    const harness = createToolHarness({ settings: { default_due: { offset_days: 3, time: "18:30" } } });
    const text = resultText(
      await harness.call("manual_add_assignment", PARENT_CONVERSATION, { subject: "Химия", items: ["§4"] }),
    );
    expect(harness.repos.raw.assignments[0]?.due_at).toBe(toIso(new Date(2026, 10, 27, 18, 30, 0, 0)));
    expect(text).toContain("через 3 дн. 18:30");
  });
});
