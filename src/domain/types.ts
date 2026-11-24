/**
 * Domain types for hmwrk (SPEC §4 roles, §5.1 states, §5.2 tables, §5.5 tools).
 *
 * Conventions:
 * - IDs are uuid v4 strings (see {@link newId}).
 * - All instants are ISO-8601 UTC strings (`toISOString()` shape), {@link IsoDateTime}.
 * - Calendar days are `YYYY-MM-DD` strings, {@link IsoDate} (local calendar day, no timezone)
 *   and wall-clock times are `HH:MM` strings, {@link TimeOfDay} (household local time).
 * - Domain vocabulary follows GLOSSARY.md: Assignment, Assignment item, Check-in,
 *   Photo, Verification, Finding, Due, Parent, Child.
 *
 * This module is pure: types, constants and ID creation only — no I/O, no storage details.
 */

/** uuid v4 string. */
export type Id = string;

/** ISO-8601 instant in UTC, e.g. `2026-11-25T17:00:00.000Z`. */
export type IsoDateTime = string;

/** Local calendar day, `YYYY-MM-DD`. */
export type IsoDate = string;

/** Wall-clock time of day in household local time, `HH:MM` (24h). */
export type TimeOfDay = string;

/** A moment given either as a `Date` or as an `IsoDateTime` (repository method inputs). */
export type DateInput = Date | IsoDateTime;

// ---------------------------------------------------------------------------
// Roles and users (SPEC §4, ADR 0004)
// ---------------------------------------------------------------------------

/** Actor role. Parent (Родитель) enters assignments and approves verdicts; child (Ребёнок) checks in. */
export type Role = "parent" | "child";

export const ROLES = ["parent", "child"] as const satisfies readonly Role[];

/** Person known to the core, mapped from an OpenWebUI account. */
export interface User {
  id: Id;
  /** Account id as reported by OpenWebUI (header / fallback API key label). */
  openwebui_user_id: string;
  role: Role;
  name: string;
  created_at: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Assignments and their items (SPEC §5.2)
// ---------------------------------------------------------------------------

/**
 * Stored assignment status (SPEC §5.1).
 *
 * `overdue` is **not** stored: it is derived as `status === "active" && due_at < now`
 * (see {@link isOverdue} in `./dates.ts`).
 */
export type AssignmentStatus = "active" | "in_review" | "done";

export const ASSIGNMENT_STATUSES = ["active", "in_review", "done"] as const satisfies readonly AssignmentStatus[];

/** Intake channel an assignment came from (SPEC §5.3). */
export type AssignmentSource = "screenshot" | "manual" | "journal";

export const ASSIGNMENT_SOURCES = ["screenshot", "manual", "journal"] as const satisfies readonly AssignmentSource[];

/** Homework for one subject with a due date. */
export interface Assignment {
  id: Id;
  /** School subject as written on the assignment, e.g. «Математика». */
  subject: string;
  /** Due (Дедлайн): instant by which a check-in is expected. */
  due_at: IsoDateTime;
  source: AssignmentSource;
  status: AssignmentStatus;
  /** Free-form note for the whole assignment (may be null). */
  note: string | null;
  created_at: IsoDateTime;
  /** Touched on every status change and item addition. */
  updated_at: IsoDateTime;
}

/** A single exercise inside an assignment («№ 12», «упражнение 3»). */
export interface AssignmentItem {
  id: Id;
  assignment_id: Id;
  /** Human label as shown to both roles. */
  label: string;
  note: string | null;
  /** Stable display order inside the assignment (0-based). */
  position: number;
  created_at: IsoDateTime;
}

/** Assignment together with its items — the shape tools and prompts render. */
export interface AssignmentWithItems extends Assignment {
  items: AssignmentItem[];
}

// ---------------------------------------------------------------------------
// Check-ins and photos (SPEC §5.2, §5.4)
// ---------------------------------------------------------------------------

/** Child's report that an assignment is done (Отчёт), accompanied by notebook photos. */
export interface CheckIn {
  id: Id;
  assignment_id: Id;
  /** `users.id` of the child who reported. */
  child_user_id: Id;
  /** Optional message from the child («сделал, но №13 не уверен»). */
  comment: string | null;
  created_at: IsoDateTime;
  /** Touched when photos are added to an existing check-in (verdict is recomputed). */
  updated_at: IsoDateTime;
}

/**
 * Photo kind: `checkin` — notebook photo attached to a check-in;
 * `screenshot` — intake screenshot from the chat (SPEC §5.3, separate subfolder on disk).
 */
export type PhotoKind = "checkin" | "screenshot";

export const PHOTO_KINDS = ["checkin", "screenshot"] as const satisfies readonly PhotoKind[];

/** File on disk; the store keeps metadata only (SPEC §5.2). */
export interface Photo {
  id: Id;
  kind: PhotoKind;
  /** Path relative to the photo root (`data/photos/`), e.g. `2026/11/<id>.jpg`. */
  path: string;
  mime: string;
  created_at: IsoDateTime;
}

/** Check-in together with its photos. */
export interface CheckInWithPhotos extends CheckIn {
  photos: Photo[];
}

// ---------------------------------------------------------------------------
// Verifications (SPEC §5.2, §5.4)
// ---------------------------------------------------------------------------

/** AI verdict lifecycle: always starts as a draft and needs a parent decision. */
export type VerificationStatus = "draft" | "approved" | "dismissed";

export const VERIFICATION_STATUSES = ["draft", "approved", "dismissed"] as const satisfies readonly VerificationStatus[];

/** One verification per AI analysis of a check-in. */
export interface Verification {
  id: Id;
  checkin_id: Id;
  status: VerificationStatus;
  /** Parent-facing summary of the whole verification. */
  summary: string;
  /** Model id that produced the draft (config slot `verify`). */
  model: string;
  created_at: IsoDateTime;
  /** Set when the parent approved or dismissed the draft. */
  decided_at: IsoDateTime | null;
  /** `users.id` of the parent who decided (null while draft). */
  decided_by_user_id: Id | null;
}

/** Per-item verdict: honest `unclear` instead of guessing (SPEC §5.4). */
export type FindingVerdict = "ok" | "wrong" | "missing" | "unclear";

export const FINDING_VERDICTS = ["ok", "wrong", "missing", "unclear"] as const satisfies readonly FindingVerdict[];

/** Verdict for one assignment item inside a verification. */
export interface VerificationFinding {
  verification_id: Id;
  item_id: Id;
  verdict: FindingVerdict;
  comment: string | null;
}

/** Verification together with its findings. */
export interface VerificationWithFindings extends Verification {
  findings: VerificationFinding[];
}

// ---------------------------------------------------------------------------
// Telegram bindings (SPEC §5.6)
// ---------------------------------------------------------------------------

/** Telegram chat bound to a user; the bot only sends messages. */
export interface TgBinding {
  user_id: Id;
  chat_id: string;
  created_at: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Settings (SPEC §5.7)
// ---------------------------------------------------------------------------

/**
 * Default due rule: how far ahead and at which wall-clock time a new assignment
 * is due when the parent does not state a concrete date. Default: tomorrow 20:00.
 */
export interface DefaultDue {
  /** 0 = today, 1 = tomorrow, … */
  offset_days: number;
  time: TimeOfDay;
}

/** Effective settings (defaults merged with stored overrides). */
export interface Settings {
  /** When the child reminder is sent (SPEC §5.6), default `19:00`. */
  reminder_time: TimeOfDay;
  /** When the parent digest is sent (SPEC §5.6), default `21:00`. */
  digest_time: TimeOfDay;
  /** Default due rule for assignments created without an explicit date. */
  default_due: DefaultDue;
  /** Both broadcasts are muted until the end of this local day; `null` = not paused. */
  paused_until: IsoDate | null;
}

export const SETTING_KEYS = ["reminder_time", "digest_time", "default_due", "paused_until"] as const;

/** Key of one setting in the `settings` key/value table. */
export type SettingKey = (typeof SETTING_KEYS)[number];

// ---------------------------------------------------------------------------
// Agent tools (SPEC §5.5)
// ---------------------------------------------------------------------------

/** Every tool the agent may call. Argument schemas live in `./schemas.ts`. */
export const TOOL_NAMES = [
  "list_assignments",
  "parse_screenshot",
  "manual_add_assignment",
  "submit_check_in",
  "get_verdicts",
  "approve_verification",
  "dismiss_verification",
  "get_settings",
  "set_setting",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Tools only a parent may call (SPEC §4, ADR 0004). Settings are parent-only in the SPEC §4
 * permissions table («Настройки (времена, пауза)»: parent ✔, child —), so `get_settings` is here
 * too and not shared with the child.
 */
export const PARENT_TOOLS = [
  "parse_screenshot",
  "manual_add_assignment",
  "approve_verification",
  "dismiss_verification",
  "get_settings",
  "set_setting",
] as const satisfies readonly ToolName[];

/** Tools only a child may call (SPEC §4). */
export const CHILD_TOOLS = ["submit_check_in"] as const satisfies readonly ToolName[];

/** Tools both roles may call (SPEC §4: both see active assignments; verdicts per role). */
export const SHARED_TOOLS = ["list_assignments", "get_verdicts"] as const satisfies readonly ToolName[];

/** Role → allowed tools (SPEC §4 permissions matrix). */
export function toolsForRole(role: Role): readonly ToolName[] {
  return role === "parent"
    ? [...PARENT_TOOLS, ...SHARED_TOOLS]
    : [...CHILD_TOOLS, ...SHARED_TOOLS];
}

/** Whether `role` may call `tool` (SPEC §4). */
export function isToolAllowed(role: Role, tool: ToolName): boolean {
  return toolsForRole(role).includes(tool);
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

/**
 * New uuid v4 string. Uses the platform CSPRNG; no filesystem or network access.
 * Repositories call this for entities they create, so callers never fabricate IDs.
 */
export function newId(): Id {
  return globalThis.crypto.randomUUID();
}
