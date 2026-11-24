/**
 * The faux-LLM script (I2): the format P2's e2e run will write, and the collection boot injects.
 *
 * These are shape tests only — the full agent cycle over the endpoint is `src/cycle.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { FauxResponseFactory, Message, TranscriptContext } from "@earendil-works/pi-ai";
import {
  FAUX_PLACEHOLDER,
  buildFauxLlm,
  createFauxLlm,
  parseFauxScript,
  placeholderContext,
  toFauxStep,
  FAUX_PROVIDERS,
} from "./faux.js";
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

describe("placeholders", () => {
  const assignmentId = "33333333-3333-4333-8333-333333333333";
  const photoA = "11111111-1111-4111-8111-111111111111";
  const photoB = "22222222-2222-4222-8222-222222222222";
  const toolResult = `• «Математика» — к 01.01.2099 10:00 — ждёт отчёта\n   пункты: № 12, № 13\n   id: ${assignmentId}`;
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: `сделал математику\n\n[к сообщению прикреплены фото: ${photoA}, ${photoB} — передай их в submit_check_in как photo_ids]` },
      ],
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "list_assignments",
      content: [{ type: "text", text: toolResult }],
      isError: false,
      timestamp: 2,
    },
  ] as unknown as Message[];

  it("reads the last tool result and the photo block from the transcript", () => {
    expect(placeholderContext(messages)).toEqual({
      lastToolResultText: toolResult,
      lastToolResultId: assignmentId,
      userPhotoIds: [photoA, photoB],
    });
  });

  it("turns a step with placeholders into a response factory", async () => {
    const step = {
      toolCalls: [
        {
          name: "submit_check_in",
          arguments: {
            assignment_id: FAUX_PLACEHOLDER.lastToolResultId,
            photo_ids: FAUX_PLACEHOLDER.userPhotoIds,
          },
        },
      ],
    };
    const factory = toFauxStep(step);
    expect(typeof factory).toBe("function");

    const message = await (factory as FauxResponseFactory)(
      { messages } as TranscriptContext,
      undefined,
      { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] },
      {} as never,
    );
    expect(message.stopReason).toBe("toolUse");
    expect(message.content[0]).toMatchObject({
      type: "toolCall",
      name: "submit_check_in",
      arguments: { assignment_id: assignmentId, photo_ids: [photoA, photoB] },
    });
  });

  it("puts the real tool result into the answer text", async () => {
    const factory = toFauxStep(FAUX_PLACEHOLDER.lastToolResultText);
    const message = await (factory as FauxResponseFactory)(
      { messages } as TranscriptContext,
      undefined,
      { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] },
      {} as never,
    );
    expect(message.content).toEqual([{ type: "text", text: toolResult }]);
  });

  it("leaves a step without placeholders a plain message", () => {
    expect(typeof toFauxStep("готово")).toBe("object");
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
