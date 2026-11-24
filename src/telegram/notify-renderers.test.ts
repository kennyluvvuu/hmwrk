/**
 * I3: the N1 → G1T renderer seam. What matters here is that nothing reaches Telegram unescaped and
 * that empty sections stay silent — the shape of the message, not the wording.
 */

import { describe, expect, it } from "vitest";
import { atLocalTime, toIso, type Assignment, type AssignmentItem, type AssignmentWithItems, type CheckIn, type Verification } from "../domain/index.js";
import type { DigestSections } from "../durable/tasks/notify.js";
import { createNotifyRenderers, renderDigestMessage, renderReminderMessage } from "./notify-renderers.js";

const NOON = new Date(2026, 10, 24, 12, 0, 0);
const TOMORROW_EVENING = atLocalTime(new Date(2026, 10, 25), "20:00");

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "a-1",
    subject: "Математика",
    due_at: toIso(TOMORROW_EVENING),
    source: "manual",
    status: "active",
    note: null,
    created_at: toIso(NOON),
    updated_at: toIso(NOON),
    ...overrides,
  };
}

function item(label: string, position: number): AssignmentItem {
  return {
    id: `i-${position}`,
    assignment_id: "a-1",
    label,
    note: null,
    position,
    created_at: toIso(NOON),
  };
}

function checkIn(overrides: Partial<CheckIn> = {}): CheckIn {
  return {
    id: "c-1",
    assignment_id: "a-1",
    child_user_id: "child",
    comment: null,
    created_at: toIso(NOON),
    updated_at: toIso(NOON),
    ...overrides,
  };
}

function verification(overrides: Partial<Verification> = {}): Verification {
  return {
    id: "v-1",
    checkin_id: "c-1",
    status: "draft",
    summary: "№ 12 верно",
    model: "faux-verify",
    created_at: toIso(NOON),
    decided_at: null,
    decided_by_user_id: null,
    ...overrides,
  };
}

function sections(overrides: Partial<DigestSections> = {}): DigestSections {
  return {
    submittedToday: [],
    overdue: [],
    pendingVerdicts: [],
    parserDrafts: [],
    ...overrides,
  };
}

describe("renderReminderMessage", () => {
  it("lists subject, items and deadline under a date heading", () => {
    const withItems: AssignmentWithItems = { ...assignment(), items: [item("№ 12", 0), item("№ 13", 1)] };

    const text = renderReminderMessage([withItems]);

    expect(text).toContain("Завтра сдать");
    expect(text).toContain("25.11.2026");
    expect(text).toContain("Математика № 12, № 13 — к 25.11.2026 20:00");
    expect(text).toContain("hmwrk");
  });

  it("escapes the data it did not author (HTML parse mode)", () => {
    const tricky: AssignmentWithItems = {
      ...assignment({ subject: "a < b & c" }),
      items: [item("№ 1 <2>", 0)],
    };

    const text = renderReminderMessage([tricky]);

    expect(text).toContain("a &lt; b &amp; c");
    expect(text).toContain("№ 1 &lt;2&gt;");
    expect(text).not.toContain("a < b");
  });

  it("is empty for an empty list, which N1 reads as «send nothing»", () => {
    expect(renderReminderMessage([])).toBe("");
  });
});

describe("renderDigestMessage", () => {
  it("renders the four sections it was given and omits the empty ones", () => {
    const overdue = assignment({ id: "a-2", subject: "Русский язык", due_at: toIso(new Date(2026, 10, 22, 20, 0)) });

    const text = renderDigestMessage(
      sections({
        submittedToday: [{ assignment: assignment(), checkIn: checkIn({ comment: "№ 13 не уверен" }) }],
        overdue: [overdue],
        pendingVerdicts: [{ verification: verification(), assignment: assignment() }],
        parserDrafts: [],
      }),
    );

    expect(text).toContain("Итоги дня");
    expect(text).toContain("Сдано сегодня");
    expect(text).toContain("Математика — № 13 не уверен");
    expect(text).toContain("Просрочено");
    expect(text).toContain("Русский язык — дедлайн 22.11.2026 20:00");
    expect(text).toContain("Ждут утверждения");
    expect(text).toContain("Математика — № 12 верно");
    expect(text).not.toContain("Скриншоты на подтверждении");
  });

  it("says the evening was quiet when every section is empty", () => {
    const text = renderDigestMessage(sections());

    expect(text).toContain("Сегодня всё спокойно");
    expect(text).not.toContain("Сдано сегодня");
  });

  it("keeps a verdict whose assignment vanished readable", () => {
    const text = renderDigestMessage(
      sections({ pendingVerdicts: [{ verification: verification({ summary: "" }), assignment: null }] }),
    );

    expect(text).toContain("задание — черновик вердикта");
  });

  it("escapes subjects and summaries", () => {
    const text = renderDigestMessage(
      sections({
        submittedToday: [{ assignment: assignment({ subject: "a < b" }), checkIn: checkIn({ comment: "x > y" }) }],
      }),
    );

    expect(text).toContain("a &lt; b — x &gt; y");
  });
});

describe("createNotifyRenderers", () => {
  it("returns both N1 dependencies", () => {
    const renderers = createNotifyRenderers();

    expect(renderers.renderReminder([])).toBe("");
    expect(typeof renderers.renderDigest(sections())).toBe("string");
  });
});
