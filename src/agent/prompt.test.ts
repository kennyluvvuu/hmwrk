/**
 * A1: the RU system prompt of SPEC §6.
 *
 * What matters here is not the wording (it will be tuned), but the promises the prompt makes:
 * parent and child get different rules, dates are `DD.MM.YYYY`, and an M1 skeleton must not
 * advertise actions it cannot perform.
 */
import { describe, expect, it } from "vitest";
import type { Role } from "../domain/types.js";
import type { AgentPromptContext } from "../contracts/agent.js";
import {
  MAX_ASSIGNMENT_LINES,
  formatPromptDate,
  formatPromptInstant,
  renderAgentPrompt,
  weekdayTitle,
  type AgentAssignmentSummary,
} from "./prompt.js";

/** Fixed household clock: Tuesday, 24.11.2026, 09:15 local (SPEC §6 date format). */
const NOW = new Date(2026, 10, 24, 9, 15, 0, 0);

function ctx(role: Role, overrides: Partial<AgentPromptContext> = {}): AgentPromptContext {
  return { userId: "u-1", role, today: "2026-11-24", now: NOW, ...overrides };
}

describe("renderAgentPrompt: роль", () => {
  it("родитель и ребёнок получают разные промпты", () => {
    const parent = renderAgentPrompt(ctx("parent"));
    const child = renderAgentPrompt(ctx("child"));
    expect(parent).not.toBe(child);
  });

  it("родитель: видит черновики, управляет утверждением и настройками", () => {
    const text = renderAgentPrompt(ctx("parent"));
    expect(text).toContain("Сейчас это Родитель.");
    expect(text).toContain("включая черновики");
    expect(text).toContain("утверждаешь или отклоняешь вердикты");
    expect(text).toContain("настраиваешь времена напоминаний");
    // A parent does not report for the child (SPEC §4).
    expect(text).toContain("не отчитываешься за ребёнка");
  });

  it("ребёнок: отчитывается и видит только утверждённые вердикты", () => {
    const text = renderAgentPrompt(ctx("child"));
    expect(text).toContain("Сейчас это Ребёнок.");
    expect(text).toContain("отчитаться о выполненном задании");
    expect(text).toContain("только утверждённые вердикты");
    expect(text).toContain("не заводишь и не меняешь задания");
  });

  it("правила одной роли не просачиваются в другую", () => {
    const parent = renderAgentPrompt(ctx("parent"));
    const child = renderAgentPrompt(ctx("child"));
    expect(parent).not.toContain("только утверждённые вердикты");
    expect(child).not.toContain("включая черновики");
    expect(child).not.toContain("настраиваешь времена напоминаний");
  });
});

describe("renderAgentPrompt: дата", () => {
  it("печатает сегодняшнюю дату как DD.MM.YYYY с днём недели", () => {
    const text = renderAgentPrompt(ctx("parent"));
    expect(text).toContain("Сегодня: 24.11.2026, вторник.");
  });

  it("объявляет формат дат и время", () => {
    const text = renderAgentPrompt(ctx("child"));
    expect(text).toContain("DD.MM.YYYY");
    expect(text).toContain("HH:MM");
    expect(text).toMatch(/например, 05\.12\.2026/);
  });

  it("дата приходит параметром, а не из часов процесса", () => {
    const text = renderAgentPrompt(ctx("parent", { today: "2027-01-09", now: new Date(2027, 0, 9, 12) }));
    expect(text).toContain("Сегодня: 09.01.2027, суббота.");
    expect(text).not.toContain("24.11.2026");
  });
});

describe("renderAgentPrompt: M1-скелет честен", () => {
  it("говорит, что доменные инструменты подключаются в следующей вехе", () => {
    const text = renderAgentPrompt(ctx("parent"), { kind: "skeleton" });
    expect(text).toContain("подключаются в следующей вехе");
    expect(text).toContain("Честность важнее имитации");
  });

  it("не перечисляет инструменты, которых нет", () => {
    const text = renderAgentPrompt(ctx("child"), { kind: "skeleton" });
    for (const name of ["list_assignments", "submit_check_in", "approve_verification"]) {
      expect(text).not.toContain(name);
    }
  });

  it("по умолчанию (без capabilities) рендерит скелет", () => {
    expect(renderAgentPrompt(ctx("parent"))).toContain("Доменных инструментов у тебя пока нет");
  });

  it("в скелете сводка заданий честно помечена как будущая", () => {
    expect(renderAgentPrompt(ctx("parent"), { kind: "skeleton" })).toContain(
      "Сводки активных заданий пока нет",
    );
  });
});

describe("renderAgentPrompt: инструменты (M2-режим)", () => {
  it("перечисляет ровно переданные имена и не говорит про скелет", () => {
    const text = renderAgentPrompt(ctx("child"), { kind: "tools", tools: ["list_assignments", "submit_check_in"] });
    expect(text).toContain("`list_assignments` — активные задания");
    expect(text).toContain("`submit_check_in` — отчёт ребёнка");
    expect(text).not.toContain("следующей вехе");
    expect(text).not.toContain("approve_verification");
  });

  it("пустой список инструментов — это «активных заданий нет», а не скелет", () => {
    const text = renderAgentPrompt(ctx("parent"), { kind: "tools", tools: [] });
    expect(text).toContain("Активных заданий нет.");
    expect(text).not.toContain("следующей вехе");
  });
});

describe("renderAgentPrompt: сводка активных заданий", () => {
  const item = (
    subject: string,
    due: string,
    status: AgentAssignmentSummary["status"] = "active",
  ): AgentAssignmentSummary => ({ subject, due_at: due, status });

  it("печатает предмет, дату DD.MM.YYYY и статус", () => {
    const due = new Date(2026, 10, 25, 20, 0).toISOString();
    const text = renderAgentPrompt(ctx("child"), { kind: "tools", tools: ["list_assignments"] }, [
      item("Математика", due),
    ]);
    expect(text).toContain("- 25.11.2026 — Математика — ждёт отчёта");
  });

  it("просрочка производная от due_at и часов запроса", () => {
    const past = new Date(2026, 10, 20, 20, 0).toISOString();
    const text = renderAgentPrompt(ctx("child"), { kind: "tools", tools: ["list_assignments"] }, [
      item("Русский язык", past),
    ]);
    expect(text).toContain("ждёт отчёта, просрочено");
  });

  it("не просрочивает сданное и находящееся на проверке", () => {
    const past = new Date(2026, 10, 20, 20, 0).toISOString();
    const text = renderAgentPrompt(ctx("parent"), { kind: "tools", tools: ["get_verdicts"] }, [
      item("Физика", past, "done"),
      item("Химия", past, "in_review"),
    ]);
    expect(text).not.toContain("просрочено");
    expect(text).toContain("— сдано");
    expect(text).toContain("— на проверке");
  });

  it("обрезает длинный список", () => {
    const due = new Date(2026, 10, 25, 20, 0).toISOString();
    const many = Array.from({ length: MAX_ASSIGNMENT_LINES + 2 }, (_, i) => item(`Предмет ${i + 1}`, due));
    const text = renderAgentPrompt(ctx("child"), { kind: "tools", tools: ["list_assignments"] }, many);
    expect(text).toContain(`- …и ещё 2`);
    expect(text).not.toContain("Предмет 9");
  });
});

describe("форматирование дат", () => {
  it("formatPromptDate: YYYY-MM-DD → DD.MM.YYYY", () => {
    expect(formatPromptDate("2026-11-24")).toBe("24.11.2026");
    expect(formatPromptDate("2027-01-05")).toBe("05.01.2027");
  });

  it("formatPromptDate не бросает на мусоре (иначе секция теряется целиком)", () => {
    expect(formatPromptDate("24.11.2026")).toBe("24.11.2026");
    expect(formatPromptDate("")).toBe("");
  });

  it("formatPromptInstant: локальные сутки инстанта", () => {
    const instant = new Date(2026, 11, 5, 20, 0).toISOString();
    expect(formatPromptInstant(instant)).toBe("05.12.2026");
    expect(formatPromptInstant("не дата")).toBe("не дата");
  });

  it("weekdayTitle: русский день недели", () => {
    expect(weekdayTitle("2026-11-24")).toBe("вторник");
    expect(weekdayTitle("2026-11-29")).toBe("воскресенье");
    expect(weekdayTitle("garbage")).toBe("");
  });
});
