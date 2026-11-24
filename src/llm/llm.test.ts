/**
 * V2 LLM layer tests: no network, no API keys — pi-ai's faux provider is scripted (R1 K6, K10).
 *
 * Every client is built over a real `Models` collection with faux providers registered under the
 * production provider ids (`groq` for `read`, `mistral` for `verify`/`chat`), so the code under
 * test is exactly the code that runs in production.
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createLogger } from "../config/logger.js";
import { alignFindings, createLlmClients, extractJsonObject, parseVerdict } from "./llm.js";
import type { LlmClients, VerifyHomeworkInput } from "./types.js";

const SLOTS = {
  read: { provider: "groq", modelId: "read-vision" },
  verify: { provider: "mistral", modelId: "verify-text" },
  chat: { provider: "mistral", modelId: "chat-text" },
} as const;

const quietLogger = createLogger({ level: "error", sink: () => undefined, bindings: { module: "llm-test" } });

interface Built {
  clients: LlmClients;
  read: ReturnType<typeof fauxProvider>;
  verify: ReturnType<typeof fauxProvider>;
}

/** Two faux providers: groq (vision) and mistral (verify + chat models), as SPEC §7 splits them. */
function build(options: { timeoutMs?: number; tokensPerSecond?: number } = {}): Built {
  const read = fauxProvider({
    provider: "groq",
    models: [{ id: SLOTS.read.modelId, input: ["text", "image"] }],
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });
  const verify = fauxProvider({
    provider: "mistral",
    models: [{ id: SLOTS.verify.modelId }, { id: SLOTS.chat.modelId }],
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });

  const models = createModels();
  models.setProvider(read.provider);
  models.setProvider(verify.provider);

  return {
    clients: createLlmClients({
      models,
      slots: SLOTS,
      logger: quietLogger,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
    read,
    verify,
  };
}

function verdictJson(overrides: Partial<{ items: unknown[]; summary: string }> = {}): string {
  return JSON.stringify({
    items: [
      { label: "№ 12", verdict: "ok", comment: "верно" },
      { label: "№ 13", verdict: "wrong", comment: "2 + 2 = 5" },
    ],
    summary: "№ 12 решён верно, в № 13 ошибка.",
    ...overrides,
  });
}

const VERIFY_INPUT: VerifyHomeworkInput = {
  assignmentText: "Предмет: Математика\nДедлайн: 2026-11-25T17:00:00.000Z",
  items: [{ label: "№ 12", note: null }, { label: "№ 13", note: "примеры" }],
  studentSolutionText: "№ 12: 5 + 7 = 12\n№ 13: 2 + 2 = 5",
};

// ---------------------------------------------------------------------------
// read: images
// ---------------------------------------------------------------------------

describe("readImages", () => {
  it("sends every photo as an image block and returns the transcription", async () => {
    const { clients, read } = build();
    let captured: unknown;
    read.setResponses([
      (context) => {
        captured = context.messages;
        return fauxAssistantMessage(fauxText("№ 12: 5 + 7 = 12"));
      },
    ]);

    const result = await clients.readImages({
      photos: [{ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }],
      prompt: "прочитай фото",
    });

    expect(result).toEqual({ text: "№ 12: 5 + 7 = 12", model: SLOTS.read.modelId });
    expect(read.state.callCount).toBe(1);

    const messages = captured as { role: string; content: { type: string; data?: string; mimeType?: string }[] }[];
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content[0]).toMatchObject({ type: "text", text: "прочитай фото" });
    expect(messages[0]?.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(messages[0]?.content[1]?.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("refuses an empty photo list before spending a model call", async () => {
    const { clients, read } = build();
    await expect(clients.readImages({ photos: [], prompt: "нет фото" })).rejects.toMatchObject({
      name: "LlmError",
      code: "invalid_input",
    });
    expect(read.state.callCount).toBe(0);
  });

  it("refuses a non-image mime", async () => {
    const { clients } = build();
    await expect(
      clients.readImages({ photos: [{ bytes: new Uint8Array([1]), mime: "application/pdf" }], prompt: "x" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ---------------------------------------------------------------------------
// verify: structured output
// ---------------------------------------------------------------------------

describe("verifyHomework", () => {
  it("parses a fenced JSON answer into per-item findings", async () => {
    const { clients, verify } = build();
    verify.setResponses([fauxAssistantMessage(fauxText("```json\n" + verdictJson() + "\n```"))]);

    const result = await clients.verifyHomework(VERIFY_INPUT);

    expect(result.degraded).toBe(false);
    expect(result.model).toBe(SLOTS.verify.modelId);
    expect(result.summary).toContain("№ 12");
    expect(result.items).toEqual([
      { label: "№ 12", verdict: "ok", comment: "верно" },
      { label: "№ 13", verdict: "wrong", comment: "2 + 2 = 5" },
    ]);
    expect(verify.state.callCount).toBe(1);
  });

  it("retries once with the parse error and succeeds", async () => {
    const { clients, verify } = build();
    verify.setResponses([
      fauxAssistantMessage(fauxText("Похоже, всё верно, но JSON я не дам.")),
      fauxAssistantMessage(fauxText(verdictJson())),
    ]);

    const result = await clients.verifyHomework(VERIFY_INPUT);

    expect(result.degraded).toBe(false);
    expect(result.items.map((item) => item.verdict)).toEqual(["ok", "wrong"]);
    expect(verify.state.callCount).toBe(2);
  });

  it("marks every item unclear after two invalid answers (no guessing, SPEC §5.4)", async () => {
    const { clients, verify } = build();
    verify.setResponses([
      fauxAssistantMessage(fauxText("не json")),
      fauxAssistantMessage(fauxText('{"items": [], "summary": ""}')),
    ]);

    const result = await clients.verifyHomework(VERIFY_INPUT);

    expect(result.degraded).toBe(true);
    expect(result.items.map((item) => item.verdict)).toEqual(["unclear", "unclear"]);
    expect(result.items.every((item) => item.comment.length > 0)).toBe(true);
    expect(result.summary).toContain("не удалось");
    expect(verify.state.callCount).toBe(2);
  });

  it("turns items the model skipped into unclear, not ok", async () => {
    const { clients, verify } = build();
    // Only one of the two labels comes back; «№ 13» must not inherit «ok».
    verify.setResponses([
      fauxAssistantMessage(
        fauxText(
          JSON.stringify({
            items: [{ label: "№ 12", verdict: "ok", comment: "верно" }],
            summary: "№ 12 верно.",
          }),
        ),
      ),
    ]);

    const result = await clients.verifyHomework(VERIFY_INPUT);

    expect(result.degraded).toBe(false);
    expect(result.items[1]).toMatchObject({ label: "№ 13", verdict: "unclear" });
  });

  it("fails clearly when the slot names a model outside the catalogue", async () => {
    const broken = createLlmClients({
      models: createModels(),
      slots: { ...SLOTS, verify: { provider: "mistral", modelId: "missing-model" } },
      logger: quietLogger,
    });

    await expect(broken.verifyHomework(VERIFY_INPUT)).rejects.toMatchObject({
      name: "LlmError",
      code: "model_unavailable",
      slot: "verify",
    });
  });

  it("times out instead of hanging the durable task", async () => {
    const { clients, verify } = build({ timeoutMs: 25, tokensPerSecond: 20 });
    verify.setResponses([fauxAssistantMessage(fauxText("долгий ответ ".repeat(40)))]);

    await expect(clients.verifyHomework(VERIFY_INPUT)).rejects.toMatchObject({
      name: "LlmError",
      code: "timeout",
    });
  });

  it("reports an empty answer as empty_response", async () => {
    const { clients, verify } = build();
    verify.setResponses([fauxAssistantMessage([])]);

    await expect(clients.verifyHomework(VERIFY_INPUT)).rejects.toMatchObject({ code: "empty_response" });
  });
});

// ---------------------------------------------------------------------------
// chat and pure helpers
// ---------------------------------------------------------------------------

describe("chat", () => {
  it("answers a plain multi-turn conversation", async () => {
    const { clients, verify } = build();
    verify.setResponses([fauxAssistantMessage(fauxText("Привет!"))]);

    const result = await clients.chat([
      { role: "system", content: "Ты помощник." },
      { role: "user", content: "привет" },
      { role: "assistant", content: "здравствуй" },
      { role: "user", content: "как дела?" },
    ]);

    expect(result).toEqual({ text: "Привет!", model: SLOTS.chat.modelId });
  });
});

describe("verdict parsing", () => {
  it("extracts the object from surrounding prose", () => {
    expect(extractJsonObject('Вот ответ: {"a":1} — готово')).toBe('{"a":1}');
    expect(extractJsonObject("без json")).toBeNull();
  });

  it("rejects a verdict without a summary", () => {
    const parsed = parseVerdict('{"items":[{"label":"№ 1","verdict":"ok","comment":""}]}');
    expect(parsed.ok).toBe(false);
  });

  it("rejects an unknown verdict value", () => {
    const parsed = parseVerdict('{"items":[{"label":"№ 1","verdict":"great","comment":""}],"summary":"ок"}');
    expect(parsed.ok).toBe(false);
  });

  it("aligns loosely written labels and keeps input order", () => {
    const aligned = alignFindings(
      [{ label: "№ 12" }, { label: "№ 13" }, { label: "№ 14" }],
      [
        { label: "№13", verdict: "wrong", comment: "ошибка" },
        { label: "12", verdict: "ok", comment: "верно" },
        { label: "№ 99", verdict: "ok", comment: "лишний" },
      ],
    );
    expect(aligned.map((item) => [item.label, item.verdict])).toEqual([
      ["№ 12", "ok"],
      ["№ 13", "wrong"],
      ["№ 14", "unclear"],
    ]);
  });
});
