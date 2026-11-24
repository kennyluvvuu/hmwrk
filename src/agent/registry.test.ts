/**
 * A1: the registry assembly point (`buildAgentRegistry` / `buildAgentExtensions`).
 *
 * M1 installs one extension with no tools. The important assertions are the **seams**: M2's nine
 * tools land inside `hmwrk` (not in a second extension), extra extensions install before it, and
 * the same list can be handed to `Harness.open({ extensions })` without reshaping anything.
 */
import { describe, expect, it } from "vitest";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import type { ConversationId, Extension, PromptInput, ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AGENT_EXTENSION_NAME,
  type ActorDirectory,
  type AgentDeps,
  type ToolName,
} from "../contracts/index.js";
import { AGENT_SECTION_KEY_INSTALLED } from "./extension.js";
import { buildAgentExtensions, buildAgentRegistry, isAgentInstalled, type AgentRegistryConfig } from "./registry.js";

const NOW = new Date(2026, 10, 24, 9, 15, 0, 0);
const CONVERSATION = 1 as ConversationId;

const actors: ActorDirectory = {
  async get() {
    return { userId: "u-parent", role: "parent" };
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

const fakeTool = (name: ToolName): ToolRegistration => ({
  name,
  description: `тестовый ${name}`,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({ output: [{ type: "text" as const, text: name }] }),
});

/** A separate extension, the way M2's imaging/hook bundle would arrive. */
const extra: Extension = defineExtension({
  name: "test-extra",
  sections: [section("test-extra-marker", () => "дополнительная секция", { tag: false })],
});

const sectionRender = async (cfg: AgentRegistryConfig, conversationId = CONVERSATION): Promise<string> => {
  const hmwrk = buildAgentRegistry(cfg).snapshot().extension(AGENT_EXTENSION_NAME);
  const section = hmwrk?.sections?.[0];
  if (section === undefined) throw new Error("hmwrk section not installed");
  const text = await section.render({ conversationId } as unknown as PromptInput, BACKGROUND_CONTEXT);
  return text ?? "";
};

describe("buildAgentRegistry: M1", () => {
  it("регистрирует hmwrk без инструментов", () => {
    const registry = buildAgentRegistry({ deps: deps() });
    expect(isAgentInstalled(registry)).toBe(true);
    expect(registry.snapshot().installed().map((extension) => extension.name)).toEqual([AGENT_EXTENSION_NAME]);
    expect(registry.snapshot().tools()).toEqual([]);
    expect(registry.snapshot().sections().map((entry) => entry.section.key)).toEqual([AGENT_SECTION_KEY_INSTALLED]);
  });

  it("пустой промпт-конфиг не требует extensions", () => {
    expect(buildAgentExtensions({ deps: deps() }).map((extension) => extension.name)).toEqual([AGENT_EXTENSION_NAME]);
  });

  it("isAgentInstalled отличает registry без hmwrk", () => {
    const registry = createRegistry();
    registry.install(extra);
    expect(isAgentInstalled(registry)).toBe(false);
    registry.install(buildAgentExtensions({ deps: deps() })[0] as Extension);
    expect(isAgentInstalled(registry)).toBe(true);
  });
});

describe("buildAgentRegistry: лишние extension'ы ставятся раньше hmwrk", () => {
  it("порядок = порядок секций в системном промпте", () => {
    const registry = buildAgentRegistry({ deps: deps(), extensions: [extra] });
    expect(registry.snapshot().installed().map((extension) => extension.name)).toEqual([
      "test-extra",
      AGENT_EXTENSION_NAME,
    ]);
    expect(registry.snapshot().sections().map((entry) => entry.section.key)).toEqual([
      "test-extra-marker",
      AGENT_SECTION_KEY_INSTALLED,
    ]);
  });

  it("buildAgentExtensions даёт тот же список для Harness.open({ extensions })", () => {
    const extensions = buildAgentExtensions({ deps: deps(), extensions: [extra] });
    expect(extensions.map((extension) => extension.name)).toEqual(["test-extra", AGENT_EXTENSION_NAME]);
  });
});

describe("шов M2: инструменты падают в hmwrk без правки сборки", () => {
  it("два инструмента из AgentToolset становятся tools расширения hmwrk", () => {
    const registry = buildAgentRegistry({
      deps: deps({ tools: { get_verdicts: fakeTool("get_verdicts"), list_assignments: fakeTool("list_assignments") } }),
    });
    const tools = registry.snapshot().tools();
    expect(tools.map((entry) => entry.tool.name)).toEqual(["list_assignments", "get_verdicts"]);
    expect(new Set(tools.map((entry) => entry.extension.name))).toEqual(new Set([AGENT_EXTENSION_NAME]));
  });

  it("промпт той же сборки уже объявляет инструменты и не говорит про скелет", async () => {
    const text = await sectionRender({
      deps: deps({ tools: { list_assignments: fakeTool("list_assignments") } }),
    });
    expect(text).toContain("`list_assignments`");
    expect(text).not.toContain("следующей вехе");
  });

  it("capabilities можно сузить, не меняя toolset", async () => {
    const text = await sectionRender({
      deps: deps({ tools: { list_assignments: fakeTool("list_assignments") }, capabilities: { kind: "skeleton" } }),
    });
    expect(text).toContain("следующей вехе");
  });
});
