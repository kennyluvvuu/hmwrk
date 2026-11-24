/**
 * Date/time utilities for the domain layer.
 *
 * Two different notions are kept apart on purpose:
 * - instants (`IsoDateTime`, UTC) — `due_at`, `created_at`, `decided_at`;
 * - local calendar days (`IsoDate`) and wall-clock times (`TimeOfDay`) — settings such as
 *   `reminder_time` or `paused_until`, which must mean the same thing when the server
 *   restarts or moves between DST offsets.
 *
 * Calendar arithmetic uses the **process local timezone** (Node honours `TZ`), so the core
 * must run with the household timezone set. No I/O happens here.
 *
 * Human phrase parsing («к пятнице», «25.11») is deliberately **not** here: turning a parent's
 * words into a date is the agent's job. These helpers only parse the canonical wire formats.
 */

import { InvalidValueError } from "./errors.js";
import type { Assignment, DefaultDue, IsoDate, IsoDateTime, TimeOfDay } from "./types.js";

/** One day in milliseconds (for rolling windows such as the reminder horizon). */
export const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY_RE = /^(\d{2}):(\d{2})$/;
const TIME_OF_DAY_INPUT_RE = /^(\d{1,2}):(\d{2})$/;

/** Current instant as `IsoDateTime`. */
export function nowIso(): IsoDateTime {
  return new Date().toISOString();
}

/** Validate a `Date` and format it as `IsoDateTime` (UTC). */
export function toIso(date: Date): IsoDateTime {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new InvalidValueError("invalid_date", "Invalid Date cannot be formatted as ISO");
  }
  return date.toISOString();
}

/** Parse an `IsoDateTime` into a `Date`. */
export function fromIso(value: IsoDateTime): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidValueError("invalid_date", `Invalid ISO datetime: ${JSON.stringify(value)}`);
  }
  return date;
}

/** Accept either a `Date` or an `IsoDateTime` (repository methods take both). */
export function asDate(value: Date | IsoDateTime): Date {
  return value instanceof Date ? value : fromIso(value);
}

// ---------------------------------------------------------------------------
// Calendar days (YYYY-MM-DD, local)
// ---------------------------------------------------------------------------

/** Whether `value` is a real `YYYY-MM-DD` calendar day. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Reject 2026-02-30: the constructed date must keep the same calendar components.
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

/** Parse `YYYY-MM-DD` into local midnight. */
export function parseIsoDate(value: IsoDate): Date {
  if (!isIsoDate(value)) {
    throw new InvalidValueError("invalid_date", `Invalid calendar day (expected YYYY-MM-DD): ${JSON.stringify(value)}`);
  }
  const match = ISO_DATE_RE.exec(value) as RegExpExecArray;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Format a `Date` as its local calendar day `YYYY-MM-DD`. */
export function formatIsoDate(date: Date): IsoDate {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local 00:00:00.000 of the day containing `date`. */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Local 23:59:59.999 of the day containing `date`. */
export function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/** Add calendar days keeping the local wall-clock time (DST-safe). */
export function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

/** Whether two instants fall on the same local calendar day. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return formatIsoDate(a) === formatIsoDate(b);
}

// ---------------------------------------------------------------------------
// Times of day (HH:MM, local)
// ---------------------------------------------------------------------------

/** Whether `value` is a canonical `HH:MM` time of day. */
export function isTimeOfDay(value: unknown): value is TimeOfDay {
  if (typeof value !== "string") return false;
  const match = TIME_OF_DAY_RE.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

/**
 * Whether `value` is an acceptable time-of-day input: canonical `HH:MM` or an
 * unpadded hour (`9:00`). Used by zod schemas so agents get a validation error,
 * not a crash.
 */
export function isTimeOfDayInput(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIME_OF_DAY_INPUT_RE.exec(value.trim());
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

/** Pad an accepted time-of-day input to canonical `HH:MM`. Throws on garbage. */
export function normalizeTimeOfDay(value: string): TimeOfDay {
  if (!isTimeOfDayInput(value)) {
    throw new InvalidValueError("invalid_time", `Invalid time of day (expected HH:MM): ${JSON.stringify(value)}`);
  }
  const match = TIME_OF_DAY_INPUT_RE.exec(value.trim()) as RegExpExecArray;
  return `${match[1]?.padStart(2, "0")}:${match[2]}`;
}

/** Parse `HH:MM` into hours and minutes. */
export function parseTimeOfDay(value: TimeOfDay): { hours: number; minutes: number } {
  if (!isTimeOfDay(value)) {
    throw new InvalidValueError("invalid_time", `Invalid time of day (expected HH:MM): ${JSON.stringify(value)}`);
  }
  const match = TIME_OF_DAY_RE.exec(value) as RegExpExecArray;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/** Format the local wall-clock time of `date` as `HH:MM`. */
export function formatTimeOfDay(date: Date): TimeOfDay {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The given local calendar day at the given wall-clock time. */
export function atLocalTime(day: Date, time: TimeOfDay): Date {
  const { hours, minutes } = parseTimeOfDay(time);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
}

// ---------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------

/** Next local day at `time` (SPEC §5.7: default due is «завтра 20:00»). */
export function tomorrowAt(now: Date, time: TimeOfDay): Date {
  return atLocalTime(addLocalDays(now, 1), time);
}

/** Instant produced by a {@link DefaultDue} rule relative to `now`. */
export function dueFromDefault(now: Date, rule: DefaultDue): Date {
  return atLocalTime(addLocalDays(now, rule.offset_days), rule.time);
}

/** `due_at` of an assignment as a `Date`. */
export function dueAt(assignment: Pick<Assignment, "due_at">): Date {
  return fromIso(assignment.due_at);
}

/**
 * Overdue (производное состояние, SPEC §5.1): stored status is `active` and the due
 * instant has passed. Assignments in `in_review` are never overdue — the child reported.
 */
export function isOverdue(assignment: Pick<Assignment, "status" | "due_at">, now: Date): boolean {
  return assignment.status === "active" && dueAt(assignment).getTime() < now.getTime();
}

/**
 * Whether an active assignment is due within the next `windowMs` — the reminder horizon
 * (SPEC §5.6: `reminder_time` walks assignments due in the next 24h without a check-in).
 * The caller still has to filter out assignments that already have a check-in.
 */
export function isDueWithinNext(
  assignment: Pick<Assignment, "status" | "due_at">,
  now: Date,
  windowMs: number = DAY_MS,
): boolean {
  if (assignment.status !== "active") return false;
  const due = dueAt(assignment).getTime();
  const from = now.getTime();
  return due >= from && due <= from + windowMs;
}

/** Whether an active assignment is due in `[from, to)`. */
export function isDueBetween(
  assignment: Pick<Assignment, "status" | "due_at">,
  from: Date,
  to: Date,
): boolean {
  if (assignment.status !== "active") return false;
  const due = dueAt(assignment).getTime();
  return due >= from.getTime() && due < to.getTime();
}

/** Whether an instant lies inside `[from, to)` (digest ranges, check-in windows). */
export function isWithinRange(instant: Date | IsoDateTime, from: Date | IsoDateTime, to: Date | IsoDateTime): boolean {
  const value = asDate(instant).getTime();
  return value >= asDate(from).getTime() && value < asDate(to).getTime();
}

/**
 * Sort helper for ascending `IsoDateTime` ordering. Returns a negative number when `a` is
 * earlier than `b`, mirroring `Array#sort`.
 */
export function compareIso(a: IsoDateTime, b: IsoDateTime): number {
  return fromIso(a).getTime() - fromIso(b).getTime();
}
