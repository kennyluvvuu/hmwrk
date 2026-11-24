/**
 * Settings defaults and value handling (SPEC §5.7).
 *
 * The `settings` table is key/value JSON, but the domain works with a typed {@link Settings}
 * object: repositories merge stored overrides with the defaults below, so every reader sees a
 * complete, valid {@link Settings}.
 *
 * Zod schemas for settings values (and the agent-facing `set_setting` union) live in
 * `./schemas.ts`; this module stays dependency-free and contains the defaults, the accepted
 * `default_due` input forms, formatting and pause semantics.
 */

import {
  endOfLocalDay,
  isIsoDate,
  isTimeOfDay,
  isTimeOfDayInput,
  normalizeTimeOfDay,
  parseIsoDate,
} from "./dates.js";
import { InvalidValueError } from "./errors.js";
import type { DefaultDue, IsoDate, SettingKey, Settings, TimeOfDay } from "./types.js";

/** Default child reminder time (SPEC §5.6). */
export const DEFAULT_REMINDER_TIME: TimeOfDay = "19:00";

/** Default parent digest time (SPEC §5.6). */
export const DEFAULT_DIGEST_TIME: TimeOfDay = "21:00";

/** Default due wall-clock time (SPEC §5.7: «завтра 20:00»). */
export const DEFAULT_DUE_TIME: TimeOfDay = "20:00";

/** Default due offset in calendar days (1 = tomorrow). */
export const DEFAULT_DUE_OFFSET_DAYS = 1;

/** The default due rule: tomorrow at 20:00 local time. */
export const DEFAULT_DUE: DefaultDue = { offset_days: DEFAULT_DUE_OFFSET_DAYS, time: DEFAULT_DUE_TIME };

/** Factory (not a shared object) so callers may mutate the copy they own. */
export function defaultSettings(): Settings {
  return { reminder_time: DEFAULT_REMINDER_TIME, digest_time: DEFAULT_DIGEST_TIME, default_due: { ...DEFAULT_DUE }, paused_until: null };
}

/** Defaults frozen for comparison and docs. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  reminder_time: DEFAULT_REMINDER_TIME,
  digest_time: DEFAULT_DIGEST_TIME,
  default_due: Object.freeze({ ...DEFAULT_DUE }) as DefaultDue,
  paused_until: null,
}) as Settings;

/** Whether `value` is a structurally valid {@link DefaultDue}. */
export function isDefaultDue(value: unknown): value is DefaultDue {
  if (typeof value !== "object" || value === null) return false;
  const rule = value as Partial<DefaultDue>;
  return (
    typeof rule.offset_days === "number" &&
    Number.isInteger(rule.offset_days) &&
    rule.offset_days >= 0 &&
    rule.offset_days <= 60 &&
    isTimeOfDay(rule.time)
  );
}

// ---------------------------------------------------------------------------
// default_due input forms
// ---------------------------------------------------------------------------

function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

function dueFromMatch(offsetDays: number, rawTime: string): DefaultDue | null {
  if (!Number.isInteger(offsetDays) || offsetDays < 0 || offsetDays > 60) return null;
  try {
    return { offset_days: offsetDays, time: normalizeTimeOfDay(rawTime) };
  } catch {
    return null;
  }
}

interface DueStringPattern {
  readonly re: RegExp;
  readonly build: (match: RegExpExecArray) => DefaultDue | null;
}

/**
 * Accepted `default_due` string forms. This is **not** general human date parsing (that is the
 * agent's job, SPEC §5.5): only the shapes the spec and the prompt use are understood, so a
 * misspelt phrase fails loudly instead of silently becoming «tomorrow».
 */
const DUE_STRING_PATTERNS: readonly DueStringPattern[] = [
  // «20:00» — bare time, spec default is next day (SPEC §5.7).
  { re: /^(\d{1,2}:\d{2})$/, build: (m) => dueFromMatch(1, group(m, 1)) },
  // «завтра 20:00» / «tomorrow 20:00»
  { re: /^(?:завтра|tomorrow)\s+(\d{1,2}:\d{2})$/i, build: (m) => dueFromMatch(1, group(m, 1)) },
  // «20:00 след. дня» (SPEC §5.7 example) / «20:00 следующего дня»
  {
    re: /^(\d{1,2}:\d{2})\s+(?:след\.?\s*дня|следующего\s+дня|tomorrow)$/i,
    build: (m) => dueFromMatch(1, group(m, 1)),
  },
  // «сегодня 22:00» / «today 22:00»
  { re: /^(?:сегодня|today)\s+(\d{1,2}:\d{2})$/i, build: (m) => dueFromMatch(0, group(m, 1)) },
  // «послезавтра 20:00»
  { re: /^послезавтра\s+(\d{1,2}:\d{2})$/i, build: (m) => dueFromMatch(2, group(m, 1)) },
  // «через 2 дня 20:00» / «через 1 день 20:00» / «через 5 дней 20:00»
  {
    re: /^через\s+(\d{1,2})\s+(?:день|дня|дней)\s+(\d{1,2}:\d{2})$/i,
    build: (m) => dueFromMatch(Number(group(m, 1)), group(m, 2)),
  },
];

/** Whether `raw` is a supported `default_due` string form. */
export function isDefaultDueString(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  return DUE_STRING_PATTERNS.some(({ re }) => re.test(raw.trim()));
}

/** Parse a supported `default_due` string form. Throws {@link InvalidValueError} otherwise. */
export function parseDefaultDueString(raw: string): DefaultDue {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    for (const { re, build } of DUE_STRING_PATTERNS) {
      const match = re.exec(trimmed);
      if (!match) continue;
      const parsed = build(match);
      if (parsed) return parsed;
    }
  }
  throw new InvalidValueError(
    "invalid_setting",
    `Unsupported default_due value ${JSON.stringify(raw)}: use {"offset_days":1,"time":"20:00"} or one of "20:00", "завтра 20:00", "20:00 след. дня", "сегодня 22:00", "через 2 дня 20:00"`,
  );
}

/** Parse either a {@link DefaultDue} object or a supported string form; normalizes the time. */
export function parseDefaultDue(value: unknown): DefaultDue {
  if (typeof value === "string") return parseDefaultDueString(value);
  if (typeof value === "object" && value !== null) {
    const rule = value as Partial<DefaultDue>;
    const offset = rule.offset_days;
    if (
      typeof offset === "number" &&
      Number.isInteger(offset) &&
      offset >= 0 &&
      offset <= 60 &&
      isTimeOfDayInput(rule.time)
    ) {
      return { offset_days: offset, time: normalizeTimeOfDay(rule.time) };
    }
  }
  throw new InvalidValueError(
    "invalid_setting",
    `Invalid default_due value: ${JSON.stringify(value)}`,
  );
}

/** Human (RU) rendering of a due rule, e.g. `завтра 20:00`. */
export function formatDefaultDue(rule: DefaultDue): string {
  const day =
    rule.offset_days === 0
      ? "сегодня"
      : rule.offset_days === 1
        ? "завтра"
        : rule.offset_days === 2
          ? "послезавтра"
          : `через ${rule.offset_days} дн.`;
  return `${day} ${rule.time}`;
}

// ---------------------------------------------------------------------------
// Effective settings
// ---------------------------------------------------------------------------

/**
 * Merge stored overrides onto defaults. Invalid stored values are ignored (default wins):
 * a corrupt row must not stop the core from booting; the writer validates before storing.
 */
export function resolveSettings(stored: Partial<Settings> | null | undefined): Settings {
  const settings = defaultSettings();
  if (!stored) return settings;

  if (isTimeOfDay(stored.reminder_time)) settings.reminder_time = stored.reminder_time;
  if (isTimeOfDay(stored.digest_time)) settings.digest_time = stored.digest_time;
  if (isDefaultDue(stored.default_due)) settings.default_due = { ...stored.default_due };
  if (stored.paused_until === null) settings.paused_until = null;
  else if (isIsoDate(stored.paused_until)) settings.paused_until = stored.paused_until;

  return settings;
}

/** Return a copy of `settings` with one already-validated key replaced. */
export function applySetting<K extends SettingKey>(settings: Settings, key: K, value: Settings[K]): Settings {
  const next: Settings = {
    ...settings,
    default_due: { ...settings.default_due },
  };
  switch (key) {
    case "reminder_time":
      next.reminder_time = value as Settings["reminder_time"];
      break;
    case "digest_time":
      next.digest_time = value as Settings["digest_time"];
      break;
    case "default_due":
      next.default_due = { ...(value as Settings["default_due"]) };
      break;
    case "paused_until":
      next.paused_until = value as Settings["paused_until"];
      break;
  }
  return next;
}

/**
 * Whether both Telegram broadcasts are muted right now (SPEC §5.6).
 *
 * `paused_until` is a calendar day and is inclusive: `paused_until = "2026-01-09"` mutes
 * through the end of 9 January local time, and broadcasts resume on 10 January.
 */
export function isPaused(settings: Pick<Settings, "paused_until">, now: Date): boolean {
  if (!settings.paused_until) return false;
  return now.getTime() <= endOfLocalDay(parseIsoDate(settings.paused_until)).getTime();
}

/** Instant at which a pause ends (exclusive upper bound), or `null` when not paused. */
export function pausedUntilInstant(pausedUntil: IsoDate | null): Date | null {
  if (!pausedUntil) return null;
  const end = endOfLocalDay(parseIsoDate(pausedUntil));
  return new Date(end.getTime() + 1);
}
