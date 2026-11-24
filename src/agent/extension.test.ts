/**
 * A1: the `hmwrk` extension object (K1/K7).
 *
 * Two levels are checked:
 * - the extension itself: name, no tools in M1, one section under `AGENT_SECTION_KEY`, and a
 *   section that renders the right role per conversation;
 * - the K1 minimum: the extension and its registry open a real `Harness` over `MemoryStorage`
 *   (the README quick start), so nothing here is a shape that only compiles.
 */
import { describe, expect, it } from "vitest";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { ConversationId, PromptInput, ToolRegistration } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AGENT_EXTENSION_NAME,
  AGENT_SECTION_KEY,
  TOOL_NAMES,
  type ActorDirectory,
  type AgentDeps,
  type AgentPromptContext,
  type ToolName,
} from "../contracts/index.js";
import { buildAgentRegistry } from "./registry.js";
import {
  AGENT_SECTION_KEY_INSTALLED,
  createAgentExtension,
  resolveAgentTools,
  resolveCapabilities,
  resolveToolNames,
} from "./extension.js";
import { renderAgentPrompt } from "./prompt.js";

const NOW = new Date(2026, 10, 24, 9, 15, 0, 0);

/** Conversations 1 → parent, 2 → child, anything else → unknown (K3 mapping is ours). */
const PARENT_CONVERSATION = 1 as ConversationId;
const CHILD_CONVERSATION = 2 as ConversationId;

const actors: ActorDirectory = {
  async get(conversationId) {
    if (conversationId === PARENT_CONVERSATION) return { userId: "u-parent", role: "parent" };
    if (conversationId === CHILD_CONVERSATION) return { userId: "u-child", role: "child" };
    return null;
  },
};

const deps = (overrides: Partial<AgentDeps> = {}): AgentDeps => ({
  actors,
  models: {
    read: { provider: "groq", modelId: "qwen/qwen3.8-27b" },
    verify: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
    chat: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
  },
  now: () => NOW,
  ...overrides,
});

/** M2 stand-in: a tool registration with a valid JSON Schema and a text result (K7). */
const fakeTool = (name: ToolName): ToolRegistration => ({
  name,
  description: `тестовый ${name}`,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({ output: [{ type: "text" as const, text: name }] }),
});

/**
 * The section only reads `input.conversationId` (the rest of `PromptInput` is the request's
 * resolution, irrelevant to the prompt), so a minimal stand-in keeps the test honest without
 * faking a whole agent resolution.
 */
const promptInput = (conversationId: ConversationId): PromptInput =>
  ({ conversationId }) as unknown as PromptInput;

const sectionOf = (d: AgentDeps) => {
  const extension = createAgentExtension(d);
  const section = extension.sections?.[0];
  if (section === undefined) throw new Error("hmwrk extension has no section");
  return section;
};

describe("createAgentExtension: форма extension", () => {
  it("называется hmwrk, в M1 без инструментов, с одной секцией", () => {
    const extension = createAgentExtension(deps());
    expect(extension.name).toBe(AGENT_EXTENSION_NAME);
    expect(extension.name).toBe("hmwrk");
    expect(extension.tools).toEqual([]);
    expect(extension.sections).toHaveLength(1);
    expect(extension.sections?.[0]?.key).toBe(AGENT_SECTION_KEY_INSTALLED);
  });

  it("ключ секции проходит валидатор registry (без точек) и не разъезжается с контрактом", () => {
    // dist/harness/registry.js: SECTION_KEY = /^[a-z][a-z0-9_-]*$/ — контрактный ключ с точками
    // registry не принимает; installed-ключ выводится из контракта.
    expect(AGENT_SECTION_KEY_INSTALLED).toMatch(/^[a-z][a-z0-9_-]*$/);
    expect(AGENT_SECTION_KEY_INSTALLED).toBe(AGENT_SECTION_KEY.replaceAll(".", "-"));
    expect(createAgentExtension(deps()).sections?.[0]?.key).toBe(AGENT_SECTION_KEY_INSTALLED);
  });

  it("имена инструментов от M2 попадают в extension в каноническом порядке", () => {
    const tools = { set_setting: fakeTool("set_setting"), list_assignments: fakeTool("list_assignments") };
    const extension = createAgentExtension(deps({ tools }));
    expect(extension.tools?.map((tool) => tool.name)).toEqual(["list_assignments", "set_setting"]);
    expect(resolveToolNames(deps({ tools }))).toEqual(["list_assignments", "set_setting"]);
  });

  it("resolveAgentTools: пустой toolset — пустой список", () => {
    expect(resolveAgentTools(deps())).toEqual([]);
    expect(resolveAgentTools(deps({ tools: {} }))).toEqual([]);
  });

  it("capabilities выводятся из toolset, если не заданы явно", () => {
    expect(resolveCapabilities(deps())).toEqual({ kind: "skeleton" });
    expect(resolveCapabilities(deps({ tools: { get_verdicts: fakeTool("get_verdicts") } }))).toEqual({
      kind: "tools",
      tools: ["get_verdicts"],
    });
    // An explicit value always wins — M2 can advertise a subset while wiring more.
    expect(resolveCapabilities(deps({ capabilities: { kind: "skeleton" } }))).toEqual({ kind: "skeleton" });
  });

  it("все девять имён SPEC §5.5 резолвятся, когда реализованы", () => {
    const tools = Object.fromEntries(TOOL_NAMES.map((name) => [name, fakeTool(name)])) as Partial<
      Record<ToolName, ToolRegistration>
    >;
    expect(resolveToolNames(deps({ tools }))).toEqual([...TOOL_NAMES]);
  });
});

describe("секция: роль из ActorDirectory", () => {
  it("родительская беседа получает родительский текст", async () => {
    const text = await sectionOf(deps()).render(promptInput(PARENT_CONVERSATION), BACKGROUND_CONTEXT);
    expect(text).toContain("Сейчас это Родитель.");
    expect(text).toContain("Сегодня: 24.11.2026, вторник.");
  });

  it("детская беседа получает детский текст", async () => {
    const text = await sectionOf(deps()).render(promptInput(CHILD_CONVERSATION), BACKGROUND_CONTEXT);
    expect(text).toContain("Сейчас это Ребёнок.");
    expect(text).not.toContain("включая черновики");
  });

  it("совпадает с renderAgentPrompt для той же роли и даты", async () => {
    const text = await sectionOf(deps()).render(promptInput(CHILD_CONVERSATION), BACKGROUND_CONTEXT);
    const expected: AgentPromptContext = { userId: "u-child", role: "child", today: "2026-11-24", now: NOW };
    expect(text).toBe(renderAgentPrompt(expected, { kind: "skeleton" }));
  });

  it("неизвестная беседа не ломает промпт: least-privilege роль ребёнка", async () => {
    const text = await sectionOf(deps()).render(promptInput(9 as ConversationId), BACKGROUND_CONTEXT);
    expect(text).toContain("Сейчас это Ребёнок.");
  });

  it("падение ActorDirectory тоже даёт промпт, а не пустую секцию", async () => {
    const broken: ActorDirectory = {
      async get() {
        throw new Error("storage down");
      },
    };
    const text = await sectionOf(deps({ actors: broken })).render(promptInput(PARENT_CONVERSATION), BACKGROUND_CONTEXT);
    expect(text).toContain("Сейчас это Ребёнок.");
  });

  it("без deps.now дата берётся из часов процесса и всё равно в DD.MM.YYYY", async () => {
    const text = await sectionOf(deps({ now: undefined })).render(promptInput(CHILD_CONVERSATION), BACKGROUND_CONTEXT);
    expect(text).toMatch(/Сегодня: \d{2}\.\d{2}\.\d{4}/);
  });
});

describe("K1-минимум: extension живёт в настоящем Harness", () => {
  it("Harness.open принимает registry с hmwrk и закрывается", async () => {
    const registry = buildAgentRegistry({ deps: deps() });
    const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, BACKGROUND_CONTEXT);
    try {
      const installed = registry.snapshot().installed().map((extension) => extension.name);
      expect(installed).toContain(AGENT_EXTENSION_NAME);
      expect(registry.snapshot().tools()).toEqual([]);
      const sections = registry.snapshot().sections();
      expect(sections.map((entry) => entry.section.key)).toEqual([AGENT_SECTION_KEY_INSTALLED]);
      expect(sections[0]?.extension.name).toBe(AGENT_EXTENSION_NAME);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});
