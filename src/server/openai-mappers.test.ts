import { describe, expect, it } from "vitest";
import type { ChatMessage, CompletionBase } from "../contracts/openai.js";
import {
  InvalidRequestError,
  chatCompletionResponse,
  chunkFromDelta,
  chunksForText,
  finishChunk,
  finishReasonFromTurn,
  mapMessagesToInput,
  messageText,
  parseChatCompletionRequest,
  splitText,
  usageFromPiUsage,
  ZERO_USAGE,
} from "./openai-mappers.js";

const base: CompletionBase = { id: "chatcmpl-test", created: 1_700_000_000, model: "hmwrk" };

describe("parseChatCompletionRequest", () => {
  it("keeps messages and the stream flag, ignoring unknown fields", () => {
    const request = parseChatCompletionRequest({
      model: "hmwrk",
      messages: [{ role: "user", content: "привет" }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      metadata: { chat_id: "abc" },
    });
    expect(request.model).toBe("hmwrk");
    expect(request.messages).toHaveLength(1);
    expect(request.stream).toBe(true);
    expect(request.stream_options?.include_usage).toBe(true);
  });

  it("defaults the model id and rejects malformed bodies", () => {
    expect(parseChatCompletionRequest({ messages: [{ role: "user", content: "x" }] }).model).toBe("hmwrk");
    expect(() => parseChatCompletionRequest(null)).toThrow(InvalidRequestError);
    expect(() => parseChatCompletionRequest({ messages: [] })).toThrow(/non-empty array/);
    expect(() => parseChatCompletionRequest({ messages: [{ role: "tool", content: "x" }] })).toThrow(/role/);
    expect(() => parseChatCompletionRequest({ messages: [{ role: "user", content: 42 }] })).toThrow(/content/);
  });

  it("keeps image_url parts for the mapper to count", () => {
    const request = parseChatCompletionRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "что тут?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } },
          ],
        },
      ],
    });
    const content = request.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
  });
});

describe("mapMessagesToInput", () => {
  it("takes the last user message, not the assistant history", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "ты — агент" },
      { role: "user", content: "первый" },
      { role: "assistant", content: "первый ответ" },
      { role: "user", content: "второй" },
    ];
    expect(mapMessagesToInput(messages)).toEqual({ input: "второй", text: "второй", images: 0 });
  });

  it("joins text parts and counts image parts without decoding them in M1", () => {
    const mapped = mapMessagesToInput([
      {
        role: "user",
        content: [
          { type: "text", text: "проверь " },
          { type: "text", text: "тетрадь" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
        ],
      },
    ]);
    expect(mapped.text).toBe("проверь тетрадь");
    expect(mapped.input).toBe("проверь тетрадь");
    expect(mapped.images).toBe(1);
  });

  it("rejects a request without a user message", () => {
    expect(() => mapMessagesToInput([{ role: "system", content: "x" }])).toThrow(/user message/);
  });

  it("messageText ignores non-text parts", () => {
    expect(messageText([{ type: "image_url", image_url: { url: "http://example.com/a.png" } }])).toBe("");
  });
});

describe("chunk building (K5)", () => {
  it("builds the role delta as the first chunk shape", () => {
    expect(chunkFromDelta(base, { role: "assistant" })).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "hmwrk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  });

  it("builds a content delta", () => {
    const chunk = chunkFromDelta(base, { content: "при" });
    expect(chunk.choices[0]?.delta).toEqual({ content: "при" });
    expect(chunk.choices[0]?.finish_reason).toBeNull();
  });

  it("builds the finish chunk with an empty delta, the reason and usage", () => {
    const chunk = finishChunk(base, "stop", ZERO_USAGE);
    expect(chunk.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "stop" });
    expect(chunk.usage).toEqual(ZERO_USAGE);
    expect(finishChunk(base, "length").usage).toBeUndefined();
  });

  it("sequences role delta → content deltas → finish, joining back to the text", () => {
    const text = "эхо твоего сообщения целиком";
    const chunks = chunksForText(base, text, { deltaChars: 6 });
    const first = chunks[0];
    const last = chunks[chunks.length - 1];
    expect(first?.choices[0]?.delta).toEqual({ role: "assistant" });
    expect(last?.choices[0]?.finish_reason).toBe("stop");
    const content = chunks
      .slice(1, -1)
      .map((chunk) => chunk.choices[0]?.delta.content ?? "")
      .join("");
    expect(content).toBe(text);
  });

  it("splits text into bounded deterministic deltas", () => {
    expect(splitText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(splitText("", 3)).toEqual([]);
    expect(splitText("abcdefgh", 100).join("")).toBe("abcdefgh");
    expect(() => splitText("x", 0)).toThrow(RangeError);
  });
});

describe("turn → OpenAI mapping", () => {
  it("maps stop reasons (K5)", () => {
    expect(finishReasonFromTurn({ status: "done", stopReason: "stop" })).toBe("stop");
    expect(finishReasonFromTurn({ status: "done", stopReason: "length" })).toBe("length");
    expect(finishReasonFromTurn({ status: "done", stopReason: "toolUse" })).toBe("tool_calls");
    expect(finishReasonFromTurn({ status: "done", stopReason: "aborted" })).toBe("stop");
    expect(finishReasonFromTurn({ status: "done", stopReason: "error" })).toBe("stop");
    expect(finishReasonFromTurn({ status: "unanswered" })).toBe("stop");
  });

  it("maps pi-ai usage onto OpenAI token fields (K12)", () => {
    expect(
      usageFromPiUsage({
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("builds the non-streaming chat.completion body", () => {
    expect(chatCompletionResponse(base, "привет")).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "hmwrk",
      choices: [{ index: 0, message: { role: "assistant", content: "привет" }, finish_reason: "stop" }],
      usage: ZERO_USAGE,
    });
  });
});
