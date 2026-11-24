import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { InvalidValueError } from "./errors.js";
import {
  assignmentItemSchema,
  assignmentSchema,
  assignmentWithItemsSchema,
  checkInSchema,
  checkInWithPhotosSchema,
  defaultDueInputSchema,
  formatZodError,
  idSchema,
  isoDateTimeSchema,
  parseSettingValue,
  parseToolArgs,
  photoSchema,
  roleSchema,
  settingValueSchemas,
  settingsSchema,
  tgBindingSchema,
  timeOfDayInputSchema,
  timeOfDaySchema,
  toolArgsSchema,
  toolArgsSchemas,
  userSchema,
  verificationFindingSchema,
  verificationSchema,
  verificationWithFindingsSchema,
} from "./schemas.js";
import { SETTING_KEYS, TOOL_NAMES, isToolAllowed, toolsForRole } from "./types.js";
import type {
  Assignment,
  AssignmentItem,
  AssignmentWithItems,
  CheckIn,
  CheckInWithPhotos,
  Photo,
  Settings,
  TgBinding,
  User,
  Verification,
  VerificationFinding,
  VerificationWithFindings,
} from "./types.js";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const AT = "2026-11-24T16:00:00.000Z";

const assignment = {
  id: ID1,
  subject: "Математика",
  due_at: AT,
  source: "manual" as const,
  status: "active" as const,
  note: null,
  created_at: AT,
  updated_at: AT,
};

const item = {
  id: ID2,
  assignment_id: ID1,
  label: "№ 12",
  note: null,
  position: 0,
  created_at: AT,
};

const checkIn = {
  id: ID3,
  assignment_id: ID1,
  child_user_id: ID2,
  comment: null,
  created_at: AT,
  updated_at: AT,
};

const photo = { id: ID1, kind: "checkin" as const, path: "2026/11/a.jpg", mime: "image/jpeg", created_at: AT };

const verification = {
  id: ID1,
  checkin_id: ID3,
  status: "draft" as const,
  summary: "№ 12 верно, № 13 не решён",
  model: "mistral/deepseek",
  created_at: AT,
  decided_at: null,
  decided_by_user_id: null,
};

const finding = { verification_id: ID1, item_id: ID2, verdict: "wrong" as const, comment: "ответ 42 вместо 24" };

describe("entity schemas (SPEC §5.2)", () => {
  it("accepts a user, incl. both roles", () => {
    const user = { id: ID1, openwebui_user_id: "owui-1", role: "parent" as const, name: "Мама", created_at: AT };
    expect(userSchema.parse(user)).toEqual(user);
    expect(roleSchema.options).toEqual(["parent", "child"]);
  });

  it("accepts an assignment and rejects bad enums, ids and instants", () => {
    expect(assignmentSchema.parse(assignment)).toEqual(assignment);
    expect(() => assignmentSchema.parse({ ...assignment, status: "overdue", source: "manual" })).toThrow();
    expect(() => assignmentSchema.parse({ ...assignment, source: "telegram" })).toThrow();
    expect(() => assignmentSchema.parse({ ...assignment, id: "not-a-uuid" })).toThrow();
    expect(() => assignmentSchema.parse({ ...assignment, due_at: "2026-11-25" })).toThrow();
    expect(() => assignmentSchema.parse({ ...assignment, subject: "" })).toThrow();
  });

  it("accepts an assignment with items", () => {
    const withItems = { ...assignment, items: [item] };
    expect(assignmentWithItemsSchema.parse(withItems)).toEqual(withItems);
    expect(() => assignmentItemSchema.parse({ ...item, position: -1 })).toThrow();
    expect(() => assignmentItemSchema.parse({ ...item, position: 1.5 })).toThrow();
  });

  it("accepts a check-in with photos", () => {
    expect(checkInSchema.parse(checkIn)).toEqual(checkIn);
    expect(checkInWithPhotosSchema.parse({ ...checkIn, photos: [photo] })).toEqual({ ...checkIn, photos: [photo] });
    expect(() => photoSchema.parse({ ...photo, kind: "screenshot-of-journal" })).toThrow();
  });

  it("accepts verification with findings and rejects unknown verdicts", () => {
    expect(verificationSchema.parse(verification)).toEqual(verification);
    expect(verificationWithFindingsSchema.parse({ ...verification, findings: [finding] }).findings).toHaveLength(1);
    expect(() => verificationFindingSchema.parse({ ...finding, verdict: "maybe" })).toThrow();
    expect(() => verificationSchema.parse({ ...verification, status: "pending" })).toThrow();
  });

  it("accepts decided verifications and telegram bindings", () => {
    const decided = { ...verification, status: "approved" as const, decided_at: AT, decided_by_user_id: ID2 };
    expect(verificationSchema.parse(decided)).toEqual(decided);
    expect(tgBindingSchema.parse({ user_id: ID1, chat_id: "123456", created_at: AT }).chat_id).toBe("123456");
  });

  it("validates canonical primitives", () => {
    expect(idSchema.parse(ID1)).toBe(ID1);
    expect(isoDateTimeSchema.parse(AT)).toBe(AT);
    expect(isoDateTimeSchema.parse("2026-11-24T19:00:00+03:00")).toBe("2026-11-24T19:00:00+03:00");
    expect(() => isoDateTimeSchema.parse("24.11.2026 19:00")).toThrow();
    expect(timeOfDaySchema.parse("19:00")).toBe("19:00");
    expect(timeOfDayInputSchema.parse("9:05")).toBe("09:05");
  });
});

describe("schema output types match the domain types", () => {
  it("keeps entity schemas and types.ts in sync", () => {
    expectTypeOf<z.infer<typeof userSchema>>().toEqualTypeOf<User>();
    expectTypeOf<z.infer<typeof assignmentSchema>>().toEqualTypeOf<Assignment>();
    expectTypeOf<z.infer<typeof assignmentItemSchema>>().toEqualTypeOf<AssignmentItem>();
    expectTypeOf<z.infer<typeof assignmentWithItemsSchema>>().toEqualTypeOf<AssignmentWithItems>();
    expectTypeOf<z.infer<typeof checkInSchema>>().toEqualTypeOf<CheckIn>();
    expectTypeOf<z.infer<typeof checkInWithPhotosSchema>>().toEqualTypeOf<CheckInWithPhotos>();
    expectTypeOf<z.infer<typeof photoSchema>>().toEqualTypeOf<Photo>();
    expectTypeOf<z.infer<typeof verificationSchema>>().toEqualTypeOf<Verification>();
    expectTypeOf<z.infer<typeof verificationFindingSchema>>().toEqualTypeOf<VerificationFinding>();
    expectTypeOf<z.infer<typeof verificationWithFindingsSchema>>().toEqualTypeOf<VerificationWithFindings>();
    expectTypeOf<z.infer<typeof tgBindingSchema>>().toEqualTypeOf<TgBinding>();
    expectTypeOf<z.infer<typeof settingsSchema>>().toEqualTypeOf<Settings>();
    expectTypeOf(parseToolArgs("get_settings", undefined)).toEqualTypeOf<Record<string, never>>();
  });

  it("get_settings tolerates missing arguments", () => {
    expect(parseToolArgs("get_settings", undefined)).toEqual({});
    expect(parseToolArgs("get_settings", {})).toEqual({});
  });
});

describe("settings schemas (SPEC §5.7)", () => {
  it("validates effective settings", () => {
    const settings = {
      reminder_time: "19:00",
      digest_time: "21:00",
      default_due: { offset_days: 1, time: "20:00" },
      paused_until: null,
    };
    expect(settingsSchema.parse(settings)).toEqual(settings);
    expect(settingsSchema.parse({ ...settings, paused_until: "2026-01-09" }).paused_until).toBe("2026-01-09");
    expect(() => settingsSchema.parse({ ...settings, reminder_time: "19" })).toThrow();
    expect(() => settingsSchema.parse({ ...settings, paused_until: "09.01.2026" })).toThrow();
  });

  it("has a value schema for every setting key", () => {
    expect(Object.keys(settingValueSchemas).sort()).toEqual([...SETTING_KEYS].sort());
  });

  it("parses and normalizes values through parseSettingValue", () => {
    expect(parseSettingValue("reminder_time", "9:05")).toBe("09:05");
    expect(parseSettingValue("digest_time", "21:00")).toBe("21:00");
    expect(parseSettingValue("default_due", "20:00 след. дня")).toEqual({ offset_days: 1, time: "20:00" });
    expect(parseSettingValue("default_due", { offset_days: 0, time: "22:00" })).toEqual({ offset_days: 0, time: "22:00" });
    expect(parseSettingValue("paused_until", "2026-01-09")).toBe("2026-01-09");
    expect(parseSettingValue("paused_until", "")).toBeNull();
    expect(parseSettingValue("paused_until", null)).toBeNull();
  });

  it("rejects bad setting values with a readable message", () => {
    expect(() => parseSettingValue("reminder_time", "25:00")).toThrow(InvalidValueError);
    expect(() => parseSettingValue("reminder_time", "поздно")).toThrow(/Invalid value for reminder_time/);
    expect(() => parseSettingValue("paused_until", "завтра")).toThrow(InvalidValueError);
    expect(() => parseSettingValue("default_due", "к пятнице")).toThrow(/default_due/);
    expect(() => parseSettingValue("nope" as never, "x")).toThrow(/Unknown setting/);
  });

  it("accepts default_due as object or supported string only", () => {
    expect(defaultDueInputSchema.parse("завтра 20:00")).toEqual({ offset_days: 1, time: "20:00" });
    expect(defaultDueInputSchema.parse({ offset_days: 2, time: "9:00" })).toEqual({ offset_days: 2, time: "09:00" });
    expect(() => defaultDueInputSchema.parse("попозже")).toThrow();
  });
});

describe("tool argument schemas (SPEC §5.5)", () => {
  it("covers exactly the nine tools", () => {
    expect(Object.keys(toolArgsSchemas).sort()).toEqual([...TOOL_NAMES].sort());
    expect(toolArgsSchema("set_setting")).toBe(toolArgsSchemas.set_setting);
  });

  it("validates list_assignments", () => {
    const schema = toolArgsSchemas.list_assignments;
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ status: "overdue" })).toEqual({ status: "overdue" });
    expect(schema.parse({ status: "all", subject: "Математика", limit: 5 })).toEqual({
      status: "all",
      subject: "Математика",
      limit: 5,
    });
    expect(() => schema.parse({ status: "in_progress" })).toThrow();
    expect(() => schema.parse({ limit: 0 })).toThrow();
    expect(() => schema.parse({ statuss: "active" })).toThrow();
  });

  it("validates parse_screenshot (photo ids or hint required)", () => {
    const schema = toolArgsSchemas.parse_screenshot;
    expect(schema.parse({ photo_ids: [ID1] })).toEqual({ photo_ids: [ID1] });
    expect(schema.parse({ hint: "математика №12-14" })).toEqual({ hint: "математика №12-14" });
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ photo_ids: [] })).toThrow();
  });

  it("validates manual_add_assignment", () => {
    const schema = toolArgsSchemas.manual_add_assignment;
    const parsed = schema.parse({
      subject: "Математика",
      items: ["№ 12", { label: "№ 13", note: "со звёздочкой" }],
      due_date: "2026-11-25",
    });
    expect(parsed.items).toHaveLength(2);
    expect(schema.parse({ subject: "x", items: ["№ 1"], due_at: AT }).due_at).toBe(AT);
    expect(() => schema.parse({ subject: "x", items: [] })).toThrow();
    expect(() => schema.parse({ subject: "x", items: ["№ 1"], due_at: AT, due_date: "2026-11-25" })).toThrow(/either due_at or due_date/);
    expect(() => schema.parse({ subject: "", items: ["№ 1"] })).toThrow();
    expect(() => schema.parse({ subject: "x", items: ["№ 1"], source: "journal" })).toThrow();
  });

  it("validates submit_check_in", () => {
    const schema = toolArgsSchemas.submit_check_in;
    expect(schema.parse({ assignment_id: ID1, photo_ids: [ID2] })).toEqual({ assignment_id: ID1, photo_ids: [ID2] });
    expect(() => schema.parse({ assignment_id: ID1, photo_ids: [] })).toThrow();
    expect(() => schema.parse({ assignment_id: ID1 })).toThrow();
    expect(() => schema.parse({ assignment_id: "42", photo_ids: [ID2] })).toThrow();
  });

  it("validates get_verdicts, approve and dismiss", () => {
    expect(toolArgsSchemas.get_verdicts.parse({})).toEqual({});
    expect(toolArgsSchemas.get_verdicts.parse({ assignment_id: ID1, status: "approved" })).toEqual({
      assignment_id: ID1,
      status: "approved",
    });
    expect(() => toolArgsSchemas.get_verdicts.parse({ status: "draftish" })).toThrow();
    expect(toolArgsSchemas.approve_verification.parse({ verification_id: ID1 })).toEqual({ verification_id: ID1 });
    expect(toolArgsSchemas.dismiss_verification.parse({ verification_id: ID1, reason: "почерк" })).toEqual({
      verification_id: ID1,
      reason: "почерк",
    });
    expect(() => toolArgsSchemas.approve_verification.parse({ verification_id: ID1, comment: "ok" })).toThrow();
  });

  it("validates get_settings and set_setting per key", () => {
    expect(toolArgsSchemas.get_settings.parse({})).toEqual({});
    expect(toolArgsSchemas.set_setting.parse({ key: "reminder_time", value: "20:00" })).toEqual({
      key: "reminder_time",
      value: "20:00",
    });
    expect(toolArgsSchemas.set_setting.parse({ key: "digest_time", value: "8:30" })).toEqual({
      key: "digest_time",
      value: "08:30",
    });
    expect(toolArgsSchemas.set_setting.parse({ key: "default_due", value: "20:00 след. дня" })).toEqual({
      key: "default_due",
      value: { offset_days: 1, time: "20:00" },
    });
    expect(toolArgsSchemas.set_setting.parse({ key: "paused_until", value: "2026-01-09" })).toEqual({
      key: "paused_until",
      value: "2026-01-09",
    });
    expect(toolArgsSchemas.set_setting.parse({ key: "paused_until", value: null })).toEqual({
      key: "paused_until",
      value: null,
    });
    expect(() => toolArgsSchemas.set_setting.parse({ key: "theme", value: "dark" })).toThrow();
    expect(() => toolArgsSchemas.set_setting.parse({ key: "reminder_time", value: "25:00" })).toThrow();
    expect(() => toolArgsSchemas.set_setting.parse({ key: "paused_until", value: "09.01.2026" })).toThrow();
    expect(() => toolArgsSchemas.set_setting.parse({ key: "default_due", value: 42 })).toThrow();
  });
});

describe("parseToolArgs", () => {
  it("returns typed arguments", () => {
    const args = parseToolArgs("submit_check_in", { assignment_id: ID1, photo_ids: [ID2] });
    expect(args.assignment_id).toBe(ID1);
    expect(args.photo_ids).toEqual([ID2]);
  });

  it("throws a readable InvalidValueError for the agent", () => {
    try {
      parseToolArgs("manual_add_assignment", { subject: "Математика", items: [] });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidValueError);
      expect((error as InvalidValueError).code).toBe("invalid_argument");
      expect((error as Error).message).toContain("manual_add_assignment");
      expect((error as Error).message).toContain("items");
    }
  });

  it("reports unknown tools", () => {
    expect(() => parseToolArgs("delete_everything" as never, {})).toThrow(/Unknown tool/);
  });

  it("gates tools by role (SPEC §4)", () => {
    expect(toolsForRole("parent")).toEqual(
      expect.arrayContaining(["manual_add_assignment", "approve_verification", "set_setting", "get_settings"]),
    );
    expect(toolsForRole("child")).toEqual(["submit_check_in", "list_assignments", "get_verdicts"]);
    expect(isToolAllowed("parent", "submit_check_in")).toBe(false);
    expect(isToolAllowed("child", "approve_verification")).toBe(false);
    expect(isToolAllowed("child", "set_setting")).toBe(false);
    expect(isToolAllowed("child", "list_assignments")).toBe(true);
    expect(new Set(toolsForRole("parent"))).toHaveLength(TOOL_NAMES.length - 1);
  });

  it("formats zod issues into one line", () => {
    const result = toolArgsSchemas.approve_verification.safeParse({ verification_id: "x" });
    expect(result.success).toBe(false);
    const message = formatZodError(result.error as never);
    expect(message).toMatch(/^verification_id: /);
    expect(message).not.toContain("\n");
  });
});
