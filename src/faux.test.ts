/**
 * The faux-LLM script (I2): the format P2's e2e run will write, and the collection boot injects.
 *
 * These are shape tests only — the full agent cycle over the endpoint is `src/cycle.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { buildFauxLlm, createFauxLlm, parseFauxScript, toFauxStep, FAUX_PROVIDERS } from "./faux.js";
import { makeTempDir } from "./durable/testkit.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

describe("parseFauxScript", () => {
  it("accepts an empty script", () => {
    expect(parseFauxScript({})).toEqual({});
  });

  it("accepts strings and tool-call steps per slot", () => {
    const script = parseFauxScript({
      chat: ["привет", { toolCalls: [{ name: "list_assignments" }] }],
      read: ["№ 12: 5 + 7 = 12"],
      verify: ['{"items":[],"summary":"ок"}'],
      repeatLast: { chat: 2 },
    });
    expect(script.chat).toHaveLength(2);
    expect(script.repeatLast).toEqual({ chat: 2 });
  });

  it("rejects an unknown step shape with the path in the message", () => {
    expect(() => parseFauxScript({ chat: [{ toolCalls: [{ nameless: true }] }] })).toThrow(/chat\.0/);
  });

  it("rejects a negative repeat", () => {
    expect(() => parseFauxScript({ repeatLast: { chat: -1 } })).toThrow(/repeatLast/);
  });
});

describe("toFauxStep", () => {
  it("turns a string into a plain text answer", () => {
    const message = toFauxStep("готово") as { content: unknown; stopReason: string };
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "готово" }]);
  });

  it("defaults a tool-call step to stopReason toolUse and keeps text after the call", () => {
    const message = toFauxStep({
      text: "сейчас посмотрю",
      toolCalls: [{ name: "get_verdicts", arguments: { status: "all" } }],
    }) as { content: { type: string; name?: string; arguments?: unknown }[]; stopReason: string };
    expect(message.stopReason).toBe("toolUse");
    expect(message.content[0]).toMatchObject({ type: "toolCall", name: "get_verdicts", arguments: { status: "all" } });
    expect(message.content[1]).toMatchObject({ type: "text", text: "сейчас посмотрю" });
  });
});

describe("buildFauxLlm", () => {
  it("registers one model per slot and returns refs that resolve into them", () => {
    const setup = buildFauxLlm({ chat: ["раз", "два"], repeatLast: { chat: 3 } });
    for (const slot of ["read", "verify", "chat"] as const) {
      const ref = setup.slots[slot];
      expect(setup.models.getModel(ref.provider, ref.modelId)).toBeDefined();
      expect(ref.provider).toBe(FAUX_PROVIDERS[slot]);
    }
    // 2 scripted answers + 3 repeats of the last one.
    expect(setup.handles.chat.getPendingResponseCount()).toBe(5);
    // The read slot accepts images (it is the vision stage of the verify task).
    expect(setup.models.getModel(FAUX_PROVIDERS.read, FAUX_PROVIDERS.read)?.input).toContain("image");
  });
});

describe("createFauxLlm", () => {
  it("reads the script file", async () => {
    const temp = makeTempDir("hmwrk-faux-");
    try {
      const path = join(temp.dir, "script.json");
      writeFileSync(path, JSON.stringify({ verify: ["вердикт"] }));
      const setup = await createFauxLlm({ scriptPath: path });
      expect(setup.handles.verify.getPendingResponseCount()).toBe(1);
    } finally {
      temp.remove();
    }
  });

  it("says why a broken script cannot boot", async () => {
    const temp = makeTempDir("hmwrk-faux-");
    try {
      const path = join(temp.dir, "script.json");
      writeFileSync(path, "{not json");
      await expect(createFauxLlm({ scriptPath: path })).rejects.toThrow(/not valid JSON/);
    } finally {
      temp.remove();
    }
  });
});
