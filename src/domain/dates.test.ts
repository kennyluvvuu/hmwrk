import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  addLocalDays,
  atLocalTime,
  compareIso,
  dueFromDefault,
  endOfLocalDay,
  formatIsoDate,
  formatTimeOfDay,
  fromIso,
  isDueBetween,
  isDueWithinNext,
  isIsoDate,
  isOverdue,
  isSameLocalDay,
  isTimeOfDay,
  isTimeOfDayInput,
  isWithinRange,
  normalizeTimeOfDay,
  parseIsoDate,
  parseTimeOfDay,
  startOfLocalDay,
  toIso,
  tomorrowAt,
} from "./dates.js";
import { DomainError } from "./errors.js";

/** Local date helper: all expectations below are expressed in local time on purpose. */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): Date {
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

describe("calendar days", () => {
  it("parses YYYY-MM-DD into local midnight and formats back", () => {
    const parsed = parseIsoDate("2026-11-25");
    expect(formatIsoDate(parsed)).toBe("2026-11-25");
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
  });

  it("rejects impossible and non-canonical days", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("25.11.2026")).toBe(false);
    expect(isIsoDate(20261125)).toBe(false);
    expect(() => parseIsoDate("2026-02-30")).toThrow(DomainError);
  });

  it("computes the bounds of a local day", () => {
    const noon = local(2026, 11, 24, 12, 30);
    expect(formatTimeOfDay(startOfLocalDay(noon))).toBe("00:00");
    expect(startOfLocalDay(noon).getDate()).toBe(24);
    expect(endOfLocalDay(noon).getHours()).toBe(23);
    expect(endOfLocalDay(noon).getMinutes()).toBe(59);
    expect(endOfLocalDay(noon).getTime()).toBeGreaterThan(noon.getTime());
  });

  it("adds calendar days across month and year boundaries", () => {
    expect(formatIsoDate(addLocalDays(local(2026, 11, 30, 20), 1))).toBe("2026-12-01");
    expect(formatIsoDate(addLocalDays(local(2026, 12, 31, 20), 1))).toBe("2027-01-01");
    expect(formatIsoDate(addLocalDays(local(2026, 11, 1, 20), -1))).toBe("2026-10-31");
  });

  it("compares local days", () => {
    expect(isSameLocalDay(local(2026, 11, 24, 0, 1), local(2026, 11, 24, 23, 59))).toBe(true);
    expect(isSameLocalDay(local(2026, 11, 24, 23, 59), local(2026, 11, 25, 0, 1))).toBe(false);
  });
});

describe("times of day", () => {
  it("accepts canonical HH:MM only", () => {
    expect(isTimeOfDay("19:00")).toBe(true);
    expect(isTimeOfDay("00:00")).toBe(true);
    expect(isTimeOfDay("23:59")).toBe(true);
    expect(isTimeOfDay("24:00")).toBe(false);
    expect(isTimeOfDay("19:60")).toBe(false);
    expect(isTimeOfDay("9:00")).toBe(false);
  });

  it("accepts unpadded input for tools and normalizes it", () => {
    expect(isTimeOfDayInput("9:05")).toBe(true);
    expect(isTimeOfDayInput(" 9:05 ")).toBe(true);
    expect(normalizeTimeOfDay("9:05")).toBe("09:05");
    expect(normalizeTimeOfDay("09:05")).toBe("09:05");
    expect(() => normalizeTimeOfDay("25:00")).toThrow(DomainError);
    expect(() => normalizeTimeOfDay("вечером")).toThrow(DomainError);
  });

  it("parses and formats wall-clock time", () => {
    expect(parseTimeOfDay("20:15")).toEqual({ hours: 20, minutes: 15 });
    expect(() => parseTimeOfDay("20:15:00")).toThrow(DomainError);
    expect(formatTimeOfDay(local(2026, 11, 24, 9, 5))).toBe("09:05");
    expect(formatTimeOfDay(atLocalTime(local(2026, 11, 24), "19:00"))).toBe("19:00");
  });
});

describe("due dates", () => {
  it("places «tomorrow at time» on the next local day", () => {
    const now = local(2026, 11, 24, 21, 5);
    const due = tomorrowAt(now, "20:00");
    expect(formatIsoDate(due)).toBe("2026-11-25");
    expect(formatTimeOfDay(due)).toBe("20:00");
  });

  it("rolls over month and year ends", () => {
    expect(formatIsoDate(tomorrowAt(local(2026, 11, 30, 8), "20:00"))).toBe("2026-12-01");
    expect(formatIsoDate(tomorrowAt(local(2026, 12, 31, 23, 30), "20:00"))).toBe("2027-01-01");
  });

  it("applies the default_due offset", () => {
    const now = local(2026, 11, 24, 9, 0);
    const tomorrow = dueFromDefault(now, { offset_days: 1, time: "20:00" });
    expect(formatIsoDate(tomorrow)).toBe("2026-11-25");

    const today = dueFromDefault(now, { offset_days: 0, time: "22:30" });
    expect(formatIsoDate(today)).toBe("2026-11-24");
    expect(formatTimeOfDay(today)).toBe("22:30");

    const inThreeDays = dueFromDefault(now, { offset_days: 3, time: "18:00" });
    expect(formatIsoDate(inThreeDays)).toBe("2026-11-27");
  });
});

describe("overdue (derived state)", () => {
  const past = toIso(local(2026, 11, 24, 18, 0));
  const future = toIso(local(2026, 11, 25, 18, 0));
  const now = local(2026, 11, 24, 21, 0);

  it("is true only for active assignments past due", () => {
    expect(isOverdue({ status: "active", due_at: past }, now)).toBe(true);
    expect(isOverdue({ status: "active", due_at: future }, now)).toBe(false);
    expect(isOverdue({ status: "in_review", due_at: past }, now)).toBe(false);
    expect(isOverdue({ status: "done", due_at: past }, now)).toBe(false);
  });

  it("isDueWithinNext covers the reminder horizon for active assignments", () => {
    expect(isDueWithinNext({ status: "active", due_at: future }, now)).toBe(true);
    expect(isDueWithinNext({ status: "in_review", due_at: future }, now)).toBe(false);
    expect(isDueWithinNext({ status: "active", due_at: past }, now)).toBe(false);
    const far = toIso(new Date(now.getTime() + DAY_MS + 60_000));
    expect(isDueWithinNext({ status: "active", due_at: far }, now)).toBe(false);
    expect(isDueWithinNext({ status: "active", due_at: far }, now, 2 * DAY_MS)).toBe(true);
  });

  it("isDueBetween is half-open", () => {
    const from = local(2026, 11, 24, 0, 0);
    const to = local(2026, 11, 25, 0, 0);
    expect(isDueBetween({ status: "active", due_at: toIso(from) }, from, to)).toBe(true);
    expect(isDueBetween({ status: "active", due_at: toIso(to) }, from, to)).toBe(false);
  });

  it("isWithinRange works for digest windows and accepts ISO input", () => {
    const from = local(2026, 11, 24, 0, 0);
    const to = local(2026, 11, 25, 0, 0);
    expect(isWithinRange(local(2026, 11, 24, 12, 0), from, to)).toBe(true);
    expect(isWithinRange(toIso(local(2026, 11, 25, 0, 0)), toIso(from), toIso(to))).toBe(false);
  });
});

describe("ISO instants", () => {
  it("round-trips through ISO strings", () => {
    const date = local(2026, 11, 24, 19, 0);
    expect(fromIso(toIso(date)).getTime()).toBe(date.getTime());
    expect(toIso(date)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("rejects invalid instants instead of producing Invalid Date", () => {
    expect(() => fromIso("24.11.2026 19:00")).toThrow(DomainError);
    expect(() => toIso(new Date(Number.NaN))).toThrow(DomainError);
  });

  it("compares instants chronologically", () => {
    const earlier = toIso(local(2026, 11, 24, 10, 0));
    const later = toIso(local(2026, 11, 24, 11, 0));
    expect(compareIso(earlier, later)).toBeLessThan(0);
    expect(compareIso(later, earlier)).toBeGreaterThan(0);
    expect(compareIso(earlier, earlier)).toBe(0);
  });
});
