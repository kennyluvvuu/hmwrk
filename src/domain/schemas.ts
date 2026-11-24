/**
 * Zod schemas: domain entities, settings values and agent tool arguments (SPEC §5.5).
 *
 * These are the single validation surface of the domain layer:
 * - the store (D2) validates rows and inputs with the entity schemas,
 * - the agent tools (A2) validate tool arguments with {@link toolArgsSchemas},
 * - the verify pipeline (V2) validates model output with the finding schemas,
 * - settings writers validate values with {@link parseSettingValue}.
 *
 * Tool argument schemas are `strictObject`s: an unexpected field is a validation error the agent
 * can read and fix, not a silently ignored typo.
 */

import { z } from "zod";
import { isTimeOfDay, isTimeOfDayInput, normalizeTimeOfDay } from "./dates.js";
import { InvalidValueError } from "./errors.js";
import { isDefaultDueString, parseDefaultDueString } from "./settings.js";
import {
  ASSIGNMENT_SOURCES,
  ASSIGNMENT_STATUSES,
  FINDING_VERDICTS,
  PHOTO_KINDS,
  ROLES,
  SETTING_KEYS,
  TOOL_NAMES,
  VERIFICATION_STATUSES,
} from "./types.js";
import type { SettingKey, Settings, ToolName } from "./types.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** uuid v4 identifier of a domain entity. */
export const idSchema = z.uuid();

/** ISO-8601 instant; UTC (`Z`) and explicit offsets are both accepted. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** Local calendar day `YYYY-MM-DD`. */
export const isoDateSchema = z.iso.date();

/** Canonical wall-clock time `HH:MM`. */
export const timeOfDaySchema = z
  .string()
  .refine(isTimeOfDay, "Time of day must be HH:MM between 00:00 and 23:59");

/** Wall-clock time input: canonical `HH:MM` or an unpadded hour (`9:00`), normalized to `HH:MM`. */
export const timeOfDayInputSchema = z
  .string()
  .refine(isTimeOfDayInput, "Time of day must be HH:MM between 00:00 and 23:59")
  .transform(normalizeTimeOfDay);

// ---------------------------------------------------------------------------
// Users and roles (SPEC §4, ADR 0004)
// ---------------------------------------------------------------------------

export const roleSchema = z.enum(ROLES);

export const userSchema = z.object({
  id: idSchema,
  openwebui_user_id: z.string().min(1),
  role: roleSchema,
  name: z.string().min(1),
  created_at: isoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// Assignments (SPEC §5.1, §5.2)
// ---------------------------------------------------------------------------

export const assignmentStatusSchema = z.enum(ASSIGNMENT_STATUSES);
export const assignmentSourceSchema = z.enum(ASSIGNMENT_SOURCES);

/** Stored statuses plus the derived `overdue` and the `all` convenience value (tool filters). */
export const assignmentStatusFilterSchema = z.enum([...ASSIGNMENT_STATUSES, "overdue", "all"]);

export const assignmentSchema = z.object({
  id: idSchema,
  subject: z.string().min(1),
  due_at: isoDateTimeSchema,
  source: assignmentSourceSchema,
  status: assignmentStatusSchema,
  note: z.string().nullable(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});

export const assignmentItemSchema = z.object({
  id: idSchema,
  assignment_id: idSchema,
  label: z.string().min(1),
  note: z.string().nullable(),
  position: z.number().int().min(0),
  created_at: isoDateTimeSchema,
});

export const assignmentWithItemsSchema = assignmentSchema.extend({
  items: z.array(assignmentItemSchema),
});

// ---------------------------------------------------------------------------
// Check-ins and photos (SPEC §5.2, §5.4)
// ---------------------------------------------------------------------------

export const checkInSchema = z.object({
  id: idSchema,
  assignment_id: idSchema,
  child_user_id: idSchema,
  comment: z.string().nullable(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});

export const photoKindSchema = z.enum(PHOTO_KINDS);

export const photoSchema = z.object({
  id: idSchema,
  kind: photoKindSchema,
  path: z.string().min(1),
  mime: z.string().min(1),
  created_at: isoDateTimeSchema,
});

export const checkInWithPhotosSchema = checkInSchema.extend({
  photos: z.array(photoSchema),
});

// ---------------------------------------------------------------------------
// Verifications (SPEC §5.2, §5.4)
// ---------------------------------------------------------------------------

export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export const findingVerdictSchema = z.enum(FINDING_VERDICTS);

export const verificationSchema = z.object({
  id: idSchema,
  checkin_id: idSchema,
  status: verificationStatusSchema,
  summary: z.string(),
  model: z.string().min(1),
  created_at: isoDateTimeSchema,
  decided_at: isoDateTimeSchema.nullable(),
  decided_by_user_id: idSchema.nullable(),
});

export const verificationFindingSchema = z.object({
  verification_id: idSchema,
  item_id: idSchema,
  verdict: findingVerdictSchema,
  comment: z.string().nullable(),
});

export const verificationWithFindingsSchema = verificationSchema.extend({
  findings: z.array(verificationFindingSchema),
});

// ---------------------------------------------------------------------------
// Telegram bindings (SPEC §5.6)
// ---------------------------------------------------------------------------

export const tgBindingSchema = z.object({
  user_id: idSchema,
  chat_id: z.string().min(1),
  created_at: isoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// Settings (SPEC §5.7)
// ---------------------------------------------------------------------------

/** Default due rule in its canonical (stored) shape. */
export const defaultDueSchema = z.object({
  offset_days: z.number().int().min(0).max(60),
  time: timeOfDayInputSchema,
});

/** `default_due` as the agent may pass it: object or one of the accepted string forms. */
export const defaultDueInputSchema = z.union([
  defaultDueSchema,
  z
    .string()
    .refine(isDefaultDueString, 'Use {"offset_days":1,"time":"20:00"} or e.g. "20:00 след. дня"')
    .transform((raw) => parseDefaultDueString(raw)),
]);

/** Effective settings. */
export const settingsSchema = z.object({
  reminder_time: timeOfDayInputSchema,
  digest_time: timeOfDayInputSchema,
  default_due: defaultDueSchema,
  paused_until: isoDateSchema.nullable(),
});

/** Value schema per setting key — the only accepted shapes of `set_setting` values. */
export const settingValueSchemas = {
  reminder_time: timeOfDayInputSchema,
  digest_time: timeOfDayInputSchema,
  default_due: defaultDueInputSchema,
  paused_until: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    isoDateSchema.nullable(),
  ),
} satisfies Record<SettingKey, z.ZodType>;

/** Human-readable one-line summary of a {@link z.ZodError} (used in tool error messages). */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "value"}: ${issue.message}`)
    .join("; ");
}

/**
 * Validate and normalize one setting value. The returned value is exactly
 * `Settings[K]`, so repositories can persist it as JSON without further checks.
 */
export function parseSettingValue<K extends SettingKey>(key: K, raw: unknown): Settings[K] {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) {
    throw new InvalidValueError("invalid_setting", `Unknown setting: ${JSON.stringify(key)}`);
  }
  const schema = settingValueSchemas[key] as unknown as z.ZodType<Settings[K]>;
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new InvalidValueError(
      "invalid_setting",
      `Invalid value for ${key}: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Tool arguments (SPEC §5.5)
// ---------------------------------------------------------------------------

/** `list_assignments` — both roles (SPEC §4). */
export const listAssignmentsArgsSchema = z.strictObject({
  /** `overdue` is derived: active and past due; `all` lists every stored status. */
  status: assignmentStatusFilterSchema.optional(),
  subject: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/** `parse_screenshot` — parent, debug-grade intake (SPEC §5.3). */
export const parseScreenshotArgsSchema = z
  .strictObject({
    photo_ids: z.array(idSchema).min(1).max(5).optional(),
    hint: z.string().min(1).optional(),
  })
  .refine(
    (args) => (args.photo_ids?.length ?? 0) > 0 || args.hint !== undefined,
    "Provide photo_ids of the attached screenshot(s) or a textual hint",
  );

/** One item of a manually added assignment: a bare label or a label with a note. */
export const assignmentItemInputSchema = z.union([
  z.string().min(1),
  z.strictObject({ label: z.string().min(1), note: z.string().nullable().optional() }),
]);

/** `manual_add_assignment` — parent (SPEC §5.3, §5.7). Creation activates immediately: no drafts. */
export const manualAddAssignmentArgsSchema = z
  .strictObject({
    subject: z.string().min(1),
    items: z.array(assignmentItemInputSchema).min(1).max(50),
    /** Concrete instant; the agent resolves human phrases itself. */
    due_at: isoDateTimeSchema.optional(),
    /** Calendar day only; the time comes from `settings.default_due.time`. */
    due_date: isoDateSchema.optional(),
    note: z.string().nullable().optional(),
  })
  .refine((args) => !(args.due_at !== undefined && args.due_date !== undefined), "Provide either due_at or due_date, not both");

/** `submit_check_in` — child (SPEC §5.4). A check-in always carries notebook photos. */
export const submitCheckInArgsSchema = z.strictObject({
  assignment_id: idSchema,
  photo_ids: z.array(idSchema).min(1).max(10),
  comment: z.string().nullable().optional(),
});

/** `get_verdicts` — both roles; role gating on status happens in the tool (SPEC §4). */
export const getVerdictsArgsSchema = z.strictObject({
  assignment_id: idSchema.optional(),
  status: z.enum([...VERIFICATION_STATUSES, "all"]).optional(),
});

/** `approve_verification` — parent only. */
export const approveVerificationArgsSchema = z.strictObject({
  verification_id: idSchema,
});

/** `dismiss_verification` — parent only; the assignment returns to `active` (see `./status.ts`). */
export const dismissVerificationArgsSchema = z.strictObject({
  verification_id: idSchema,
  reason: z.string().min(1).optional(),
});

/** `get_settings` — parent only (SPEC §4); takes no arguments, `undefined` is tolerated. */
export const getSettingsArgsSchema = z.strictObject({}).default({});

/** `set_setting` — parent only; the value schema depends on the key. */
export const setSettingArgsSchema = z.discriminatedUnion("key", [
  z.strictObject({ key: z.literal("reminder_time"), value: timeOfDayInputSchema }),
  z.strictObject({ key: z.literal("digest_time"), value: timeOfDayInputSchema }),
  z.strictObject({ key: z.literal("default_due"), value: defaultDueInputSchema }),
  z.strictObject({ key: z.literal("paused_until"), value: z.union([isoDateSchema, z.null()]) }),
]);

/** Argument schema per tool name — the contract A2 wires into the agent registry. */
export const toolArgsSchemas = {
  list_assignments: listAssignmentsArgsSchema,
  parse_screenshot: parseScreenshotArgsSchema,
  manual_add_assignment: manualAddAssignmentArgsSchema,
  submit_check_in: submitCheckInArgsSchema,
  get_verdicts: getVerdictsArgsSchema,
  approve_verification: approveVerificationArgsSchema,
  dismiss_verification: dismissVerificationArgsSchema,
  get_settings: getSettingsArgsSchema,
  set_setting: setSettingArgsSchema,
} satisfies Record<ToolName, z.ZodType>;

/** Parsed arguments of a tool. */
export type ToolArgs<N extends ToolName> = z.infer<(typeof toolArgsSchemas)[N]>;

/**
 * Validate raw tool arguments. Throws {@link InvalidValueError} with a single-line message the
 * tool can hand back to the agent (SPEC §5.5: «кривые аргументы → человекочитаемая ошибка»).
 */
export function parseToolArgs<N extends ToolName>(name: N, raw: unknown): ToolArgs<N> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) {
    throw new InvalidValueError("invalid_argument", `Unknown tool: ${JSON.stringify(name)}`);
  }
  const result = toolArgsSchemas[name].safeParse(raw);
  if (!result.success) {
    throw new InvalidValueError("invalid_argument", `Invalid arguments for ${name}: ${formatZodError(result.error)}`);
  }
  return result.data as ToolArgs<N>;
}

/** The schema of one tool, for JSON-Schema generation in the agent registry. */
export function toolArgsSchema(name: ToolName): z.ZodType {
  return toolArgsSchemas[name];
}
