import { describe, expect, it } from "vitest";
import { escapeHtml } from "./bindings.js";
import { renderDigest, renderReminder, renderTestMessage } from "./templates.js";

const SIGNATURE = "hmwrk";

describe("renderReminder", () => {
  it("lists subject and item labels and asks for a check-in", () => {
    const text = renderReminder({
      items: [
        { subject: "Математика", label: "№ 12" },
        { subject: "Английский", label: "упр. 3" },
      ],
    });

    expect(text).toContain("Завтра сдать");
    expect(text).toContain("• Математика № 12");
    expect(text).toContain("• Английский упр. 3");
    expect(text).toContain(`Не забудь отчитаться в ${SIGNATURE}.`);
    expect(text?.endsWith("Не забудь отчитаться в hmwrk.")).toBe(true);
  });

  it("returns null when nothing is due (nothing to send)", () => {
    expect(renderReminder({ items: [] })).toBeNull();
  });

  it("includes the caller-formatted date and a detail suffix", () => {
    const text = renderReminder({
      date: "26.11",
      items: [{ subject: "Русский", due_at: "дедлайн 26.11 20:00" }],
    });

    expect(text).toContain("Завтра сдать (26.11)");
    expect(text).toContain("• Русский — дедлайн 26.11 20:00");
  });

  it("escapes HTML so parse_mode=HTML cannot break the message", () => {
    const text = renderReminder({ items: [{ subject: "a < b & c > d", label: "<script>" }] });

    expect(text).toContain("• a &lt; b &amp; c &gt; d &lt;script&gt;");
    expect(text).not.toContain("<script>");
  });

  it("escapes every data string exactly once (no double escaping)", () => {
    expect(escapeHtml("a &amp; b")).toBe("a &amp;amp; b");
    expect(renderReminder({ items: [{ subject: "&lt;" }] })).toContain("&amp;lt;");
  });
});

describe("renderDigest", () => {
  const all = {
    completedToday: [{ subject: "Математика", label: "№ 12" }],
    overdue: [{ subject: "Русский", detail: "дедлайн 24.11 20:00" }],
    pendingVerdicts: [{ subject: "Английский" }],
    pendingParses: [{ subject: "Окружающий мир" }],
  };

  it("renders all four sections and ends with the signature", () => {
    const text = renderDigest({ date: "26.11", ...all });

    expect(text).toContain("Итоги дня (26.11)");
    expect(text).toContain("Сдано сегодня");
    expect(text).toContain("Просрочено");
    expect(text).toContain("Ждут утверждения");
    expect(text).toContain("Скриншоты на подтверждении");
    expect(text).toContain("• Математика № 12");
    expect(text).toContain("• Русский — дедлайн 24.11 20:00");
    expect(text.split("\n").at(-1)).toBe(SIGNATURE);
  });

  it("omits empty sections instead of printing their headings", () => {
    const text = renderDigest({
      completedToday: [],
      overdue: [{ subject: "Русский" }],
      pendingVerdicts: [],
      pendingParses: [],
    });

    expect(text).toContain("Просрочено");
    expect(text).not.toContain("Сдано сегодня");
    expect(text).not.toContain("Ждут утверждения");
    expect(text).not.toContain("Скриншоты на подтверждении");
    expect(text.split("\n").at(-1)).toBe(SIGNATURE);
  });

  it("says the day was quiet when every section is empty", () => {
    const text = renderDigest({ completedToday: [], overdue: [], pendingVerdicts: [], pendingParses: [] });

    expect(text).toContain("Сегодня всё спокойно");
    expect(text.split("\n").at(-1)).toBe(SIGNATURE);
  });

  it("escapes subjects in every section", () => {
    const text = renderDigest({
      completedToday: [],
      overdue: [{ subject: "<b>взлом</b>" }],
      pendingVerdicts: [],
      pendingParses: [],
    });

    expect(text).toContain("• &lt;b&gt;взлом&lt;/b&gt;");
    expect(text).not.toContain("<b>взлом</b>");
  });
});

describe("renderTestMessage", () => {
  it("states that the broadcast is configured and echoes the chat id as code", () => {
    const text = renderTestMessage({ role: "parent", chatId: "123456789" });

    expect(text).toContain("проверка связи");
    expect(text).toContain("Роль: родитель");
    expect(text).toContain("<code>123456789</code>");
    expect(text.split("\n").at(-1)).toBe(SIGNATURE);
  });

  it("works without a role or chat id", () => {
    const text = renderTestMessage();

    expect(text).toContain("рассылки настроены");
    expect(text).not.toContain("Роль:");
    expect(text).not.toContain("chat_id:");
  });

  it("escapes the chat id it echoes", () => {
    expect(renderTestMessage({ chatId: "<1>" })).toContain("<code>&lt;1&gt;</code>");
  });
});
