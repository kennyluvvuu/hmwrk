/**
 * A2: the shared shell of the nine tools — assembly, parameters (K7), role gating, argument errors.
 *
 * The point of these cases is that gating and validation are *not* per-tool code: whatever is
 * asserted here holds for all nine because they are created by one factory (`tool.ts`).
 */

import { compile } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { buildAgentRegistry } from "../registry.js";
import { TOOL_NAMES } from "../../domain/types.js";
import {
  CHILD_CONVERSATION,
  CHILD_USER_ID,
  createToolHarness,
  PARENT_CONVERSATION,
  PARENT_USER_ID,
  resultText,
  seedAssignment,
  seedDraft,
  UNKNOWN_CONVERSATION,
} from "./testing/harness.js";

const h = () => createToolHarness();

describe("createHmwrkTools: состав и порядок", () => {
  it("все девять инструментов SPEC §5.5, в каноническом порядке TOOL_NAMES", () => {
    const harness = h();
    expect(Object.keys(harness.tools)).toEqual([...TOOL_NAMES]);
    for (const name of TOOL_NAMES) expect(harness.tools[name]?.name).toBe(name);
  });

  it("у каждого инструмента RU-описание, объясняющее, когда его вызывать", () => {
    const harness = h();
    for (const name of TOOL_NAMES) {
      const tool = harness.tools[name];
      if (tool === undefined) throw new Error(`missing ${name}`);
      expect(tool.description, name).toMatch(/[А-Яа-я]/);
      expect(tool.description, name).toContain("Вызывай");
    }
  });

  it("параметры — JSON Schema из zod (strict object, $schema, additionalProperties: false)", () => {
    const harness = h();
    const list = harness.tools.list_assignments?.parameters as Record<string, unknown>;
    expect(list.type).toBe("object");
    expect(list.additionalProperties).toBe(false);
    expect(Object.keys(list.properties as object).sort()).toEqual(["limit", "status", "subject"]);

    const add = harness.tools.manual_add_assignment?.parameters as Record<string, unknown>;
    expect(add.required).toEqual(["subject", "items"]);
    // `.optional()` stays out of `required`; a transform (time of day) is exposed as its input string.
    expect((add.properties as Record<string, { type?: string }>).due_at?.type).toBe("string");

    const set = harness.tools.set_setting?.parameters as Record<string, unknown>;
    // Discriminated union of strict objects survives the bridge as `oneOf`.
    expect(Array.isArray(set.oneOf)).toBe(true);
  });
});

describe("ролевой гейтинг: роль из беседы, а не из аргументов", () => {
  it("незнакомая беседа → вежливый отказ, данные не тронуты", async () => {
    const harness = h();
    const result = await harness.call("list_assignments", UNKNOWN_CONVERSATION, {});
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("не связана ни с родителем, ни с ребёнком");
  });

  it("ребёнку недоступны родительские действия — отказ и никаких записей", async () => {
    const harness = h();
    const before = harness.repos.raw.assignments.length;

    const add = harness.call("manual_add_assignment", CHILD_CONVERSATION, {
      subject: "Физика",
      items: ["№1"],
    });
    const approve = harness.call("approve_verification", CHILD_CONVERSATION, {
      verification_id: "00000000-0000-4000-8000-000000000000",
    });
    const setSetting = harness.call("set_setting", CHILD_CONVERSATION, { key: "reminder_time", value: "20:00" });
    const settings = harness.call("get_settings", CHILD_CONVERSATION, {});

    for (const result of [await add, await approve, await setSetting, await settings]) {
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("это действие родителя");
    }
    expect(harness.repos.raw.assignments).toHaveLength(before);
    expect(harness.repos.raw.settings).toEqual({});
  });

  it("родителю недоступен отчёт за ребёнка", async () => {
    const harness = h();
    const assignment = await seedAssignment(harness.repos);
    const result = await harness.call("submit_check_in", PARENT_CONVERSATION, {
      assignment_id: assignment.id,
      photo_ids: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("делает только ребёнок");
    expect(harness.repos.raw.checkIns).toHaveLength(0);
    expect((await harness.repos.assignments.get(assignment.id))?.status).toBe("active");
  });

  it("общие инструменты доступны обеим ролям", async () => {
    const harness = h();
    await seedAssignment(harness.repos);
    const parent = await harness.call("list_assignments", PARENT_CONVERSATION, {});
    const child = await harness.call("list_assignments", CHILD_CONVERSATION, {});
    expect(parent.isError).toBeUndefined();
    expect(child.isError).toBeUndefined();
    expect(resultText(child)).toContain("Математика");
  });
});

describe("кривые аргументы → человекочитаемая ошибка", () => {
  it("refine, невыразимый в JSON Schema: due_at и due_date одновременно", async () => {
    const harness = h();
    const result = await harness.call("manual_add_assignment", PARENT_CONVERSATION, {
      subject: "Физика",
      items: ["№1"],
      due_at: "2026-11-25T17:00:00.000Z",
      due_date: "2026-11-25",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Не понял аргументы");
    expect(resultText(result)).not.toContain("at Object");
    expect(harness.repos.raw.assignments).toHaveLength(0);
  });

  it("лишнее поле (strictObject) названо в ошибке", async () => {
    const harness = h();
    const result = await harness.call("list_assignments", PARENT_CONVERSATION, { limit: 5, linit: 5 });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("linit");
  });

  it("parse_screenshot требует photo_ids или hint", async () => {
    const harness = h();
    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, {});
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Не понял аргументы");
  });

  it("submit_check_in без фото отклоняется схемой", async () => {
    const harness = h();
    const assignment = await seedAssignment(harness.repos);
    const result = await harness.call("submit_check_in", CHILD_CONVERSATION, {
      assignment_id: assignment.id,
      photo_ids: [],
    });
    expect(result.isError).toBe(true);
    expect(harness.repos.raw.checkIns).toHaveLength(0);
  });

  it("не-uuid в id — ошибка аргумента, а не падение", async () => {
    const harness = h();
    const result = await harness.call("approve_verification", PARENT_CONVERSATION, { verification_id: "42" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Не понял аргументы");
  });
});

describe("ролевые идентификаторы", () => {
  it("отчёт пишется от имени владельца беседы, а не из аргументов", async () => {
    const harness = h();
    const assignment = await seedAssignment(harness.repos);
    const photo = await harness.repos.photos.create({ kind: "checkin", path: "p.jpg", mime: "image/jpeg" });
    await harness.call("submit_check_in", CHILD_CONVERSATION, { assignment_id: assignment.id, photo_ids: [photo.id] });
    expect(harness.repos.raw.checkIns[0]?.child_user_id).toBe(CHILD_USER_ID);
    expect(harness.repos.raw.checkIns[0]?.child_user_id).not.toBe(PARENT_USER_ID);
  });

  it("решение фиксирует родителя как decided_by_user_id", async () => {
    const harness = h();
    const assignment = await seedAssignment(harness.repos, { status: "in_review" });
    const { verification } = await seedDraft(harness.repos, assignment.id);
    await harness.call("approve_verification", PARENT_CONVERSATION, { verification_id: verification.id });
    expect((await harness.repos.verifications.get(verification.id))?.decided_by_user_id).toBe(PARENT_USER_ID);
  });
});

describe("шов A1/K7: инструменты — настоящие ToolRegistration", () => {
  it("registry агента принимает все девять и публикует их в каноническом порядке", () => {
    const harness = createToolHarness();
    const registry = buildAgentRegistry({
      deps: {
        actors: { get: async () => null },
        models: {
          read: { provider: "groq", modelId: "qwen/qwen3.8-27b" },
          verify: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
          chat: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
        },
        tools: harness.tools,
      },
    });
    expect(registry.snapshot().tools().map((entry) => entry.tool.name)).toEqual([...TOOL_NAMES]);
  });

  it("параметры компилируются pi-schema — тем же валидатором, что проверяет вызовы в Harness", () => {
    const harness = createToolHarness();
    const valid: Record<string, unknown> = {
      list_assignments: {},
      parse_screenshot: { hint: "дневник" },
      manual_add_assignment: { subject: "Математика", items: ["№12"] },
      submit_check_in: {
        assignment_id: "11111111-1111-4111-8111-111111111111",
        photo_ids: ["22222222-2222-4222-8222-222222222222"],
      },
      get_verdicts: { status: "all" },
      approve_verification: { verification_id: "11111111-1111-4111-8111-111111111111" },
      dismiss_verification: { verification_id: "11111111-1111-4111-8111-111111111111", reason: "неверно" },
      get_settings: {},
      set_setting: { key: "default_due", value: "20:00 след. дня" },
    };

    for (const name of TOOL_NAMES) {
      const parameters = harness.tools[name]?.parameters as Record<string, unknown>;
      const validator = compile(parameters as never, { coerce: true });
      const parsed = validator.parse(valid[name]);
      expect(parsed.ok, `${name}: ${parsed.ok ? "" : JSON.stringify(parsed.errors)}`).toBe(true);
    }
  });

  it("лишнее поле и неверный тип отклоняются на уровне pi-schema", () => {
    const harness = createToolHarness();
    const validator = compile(harness.tools.list_assignments?.parameters as never, { coerce: true });
    expect(validator.parse({ limit: 5, linit: 5 }).ok).toBe(false);
    // K7: coercion is the harness behaviour — "5" becomes 5 rather than an error.
    const coerced = validator.parse({ limit: "5" });
    expect(coerced.ok).toBe(true);
    expect(coerced.ok && (coerced.value as { limit: number }).limit).toBe(5);
  });
});
