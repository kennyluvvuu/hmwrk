import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import {
  DEFAULT_DIGEST_TIME,
  DEFAULT_DUE,
  DEFAULT_REMINDER_TIME,
  DEFAULT_SETTINGS,
  applySetting,
  defaultSettings,
  formatDefaultDue,
  isDefaultDue,
  isDefaultDueString,
  isPaused,
  parseDefaultDue,
  parseDefaultDueString,
  pausedUntilInstant,
  resolveSettings,
} from "./settings.js";
import type { Settings } from "./types.js";

function local(year: number, month: number, day: number, hours = 0, minutes = 0): Date {
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

describe("settings defaults (SPEC §5.7)", () => {
  it("uses the spec defaults: 19:00, 21:00, tomorrow 20:00, no pause", () => {
    expect(DEFAULT_REMINDER_TIME).toBe("19:00");
    expect(DEFAULT_DIGEST_TIME).toBe("21:00");
    expect(DEFAULT_DUE).toEqual({ offset_days: 1, time: "20:00" });
    expect(DEFAULT_SETTINGS).toEqual({
      reminder_time: "19:00",
      digest_time: "21:00",
      default_due: { offset_days: 1, time: "20:00" },
      paused_until: null,
    });
  });

  it("hands out copies so callers cannot corrupt the defaults", () => {
    const first = defaultSettings();
    first.reminder_time = "06:00";
    first.default_due.time = "06:00";
    expect(defaultSettings().reminder_time).toBe("19:00");
    expect(DEFAULT_SETTINGS.default_due.time).toBe("20:00");
  });
});

describe("resolveSettings", () => {
  it("merges stored overrides onto defaults", () => {
    const resolved = resolveSettings({ reminder_time: "18:30", paused_until: "2026-01-09" });
    expect(resolved.reminder_time).toBe("18:30");
    expect(resolved.digest_time).toBe("21:00");
    expect(resolved.default_due).toEqual({ offset_days: 1, time: "20:00" });
    expect(resolved.paused_until).toBe("2026-01-09");
  });

  it("ignores corrupt stored values instead of failing to boot", () => {
    const corrupt = {
      reminder_time: "25:00",
      digest_time: 21,
      default_due: { offset_days: -1, time: "20:00" },
      paused_until: "09.01.2026",
    } as unknown as Partial<Settings>;
    expect(resolveSettings(corrupt)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps an explicit null pause", () => {
    expect(resolveSettings({ paused_until: null }).paused_until).toBeNull();
  });
});

describe("default_due parsing", () => {
  it("accepts the spec forms", () => {
    expect(parseDefaultDueString("20:00 след. дня")).toEqual({ offset_days: 1, time: "20:00" });
    expect(parseDefaultDueString("20:00 следующего дня")).toEqual({ offset_days: 1, time: "20:00" });
    expect(parseDefaultDueString("завтра 20:00")).toEqual({ offset_days: 1, time: "20:00" });
    expect(parseDefaultDueString("20:00")).toEqual({ offset_days: 1, time: "20:00" });
    expect(parseDefaultDueString("сегодня 22:30")).toEqual({ offset_days: 0, time: "22:30" });
    expect(parseDefaultDueString("today 22:30")).toEqual({ offset_days: 0, time: "22:30" });
    expect(parseDefaultDueString("послезавтра 19:00")).toEqual({ offset_days: 2, time: "19:00" });
    expect(parseDefaultDueString("через 3 дня 18:00")).toEqual({ offset_days: 3, time: "18:00" });
  });

  it("normalizes unpadded hours", () => {
    expect(parseDefaultDueString("9:05")).toEqual({ offset_days: 1, time: "09:05" });
  });

  it("trims and case-folds tolerant input", () => {
    expect(parseDefaultDueString("  Завтра 20:00 ")).toEqual({ offset_days: 1, time: "20:00" });
  });

  it("rejects free-form phrases (that is the agent's job)", () => {
    expect(isDefaultDueString("в пятницу вечером")).toBe(false);
    expect(() => parseDefaultDueString("в пятницу вечером")).toThrow(DomainError);
    expect(() => parseDefaultDue("blah")).toThrow(DomainError);
  });

  it("validates object values", () => {
    expect(parseDefaultDue({ offset_days: 2, time: "9:00" })).toEqual({ offset_days: 2, time: "09:00" });
    expect(isDefaultDue({ offset_days: 2, time: "09:00" })).toBe(true);
    expect(isDefaultDue({ offset_days: 1.5, time: "09:00" })).toBe(false);
    expect(isDefaultDue({ offset_days: 1, time: "09:00", extra: true })).toBe(true);
    expect(isDefaultDue({ offset_days: 61, time: "09:00" })).toBe(false);
  });

  it("formats a rule for human messages", () => {
    expect(formatDefaultDue({ offset_days: 1, time: "20:00" })).toBe("завтра 20:00");
    expect(formatDefaultDue({ offset_days: 0, time: "22:00" })).toBe("сегодня 22:00");
    expect(formatDefaultDue({ offset_days: 2, time: "19:00" })).toBe("послезавтра 19:00");
    expect(formatDefaultDue({ offset_days: 5, time: "19:00" })).toBe("через 5 дн. 19:00");
  });
});

describe("applySetting", () => {
  it("replaces one key and keeps the input untouched", () => {
    const before = defaultSettings();
    const after = applySetting(before, "reminder_time", "08:15");
    expect(after.reminder_time).toBe("08:15");
    expect(before.reminder_time).toBe("19:00");
    expect(after.default_due).toEqual(before.default_due);
    expect(after.default_due).not.toBe(before.default_due);
  });

  it("supports default_due and paused_until", () => {
    const withDue = applySetting(defaultSettings(), "default_due", { offset_days: 0, time: "21:00" });
    expect(withDue.default_due).toEqual({ offset_days: 0, time: "21:00" });
    const paused = applySetting(withDue, "paused_until", "2026-01-09");
    expect(paused.paused_until).toBe("2026-01-09");
    expect(applySetting(paused, "paused_until", null).paused_until).toBeNull();
  });
});

describe("isPaused (SPEC §5.6)", () => {
  it("mutes through the end of the paused day, inclusive", () => {
    const settings = { paused_until: "2026-01-09" };
    expect(isPaused(settings, local(2026, 1, 9, 0, 0))).toBe(true);
    expect(isPaused(settings, local(2026, 1, 9, 23, 59))).toBe(true);
    expect(isPaused(settings, local(2026, 1, 10, 0, 0))).toBe(false);
    expect(isPaused(settings, local(2026, 1, 8, 12, 0))).toBe(true);
  });

  it("is off when no pause is set or the pause is over", () => {
    expect(isPaused({ paused_until: null }, local(2026, 1, 9, 12, 0))).toBe(false);
    expect(isPaused({ paused_until: "2025-12-31" }, local(2026, 1, 9, 12, 0))).toBe(false);
  });

  it("exposes the instant when broadcasting resumes", () => {
    expect(pausedUntilInstant(null)).toBeNull();
    const resume = pausedUntilInstant("2026-01-09");
    expect(resume).not.toBeNull();
    expect(formatLocal(resume as Date)).toBe("2026-01-10 00:00");
  });
});

function formatLocal(date: Date): string {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${day} ${time}`;
}
