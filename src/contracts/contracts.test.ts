/**
 * Sanity checks for T3 contracts: the shapes compile against real pi-durable/pi-ai types and the
 * stubs are honest placeholders (W3 replaces them with implementations).
 */
import { describe, expect, it } from "vitest";
import type { Role } from "../domain/index.js";
import type { Config } from "../config/index.js";
import {
  APP_ATTRIBUTION,
  PI_SCHEMA_PREFIX,
  chunkFromDelta,
  createRoleResolver,
  finishChunk,
  finishReasonFromTurn,
  mapMessagesToInput,
  openHarness,
  toToolParameters,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type HarnessConfig,
  type UserConversationIndex,
} from "./index.js";

/** `Config` must stay assignable to the facade's narrow config (S1 passes it directly). */
const asHarnessConfig = (cfg: Config): HarnessConfig => cfg;

const request = {
  model: "hmwrk",
  messages: [
    { role: "system", content: "ты помощник" },
    { role: "user", content: "что задали?" },
    {
      role: "user",
      content: [
        { type: "text", text: "прочитай задание" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ],
  stream: true,
  temperature: 0.2,
  user: "u-1",
} satisfies ChatCompletionRequest;

const chunk = {
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "hmwrk",
  choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
} satisfies ChatCompletionChunk;

const response = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "hmwrk",
  choices: [
    { index: 0, message: { role: "assistant", content: "математика" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
} satisfies ChatCompletionResponse;

const index = {
  byUser: { "key:parent": 1 },
  actors: { "1": { userId: "key:parent", role: "parent" satisfies Role } },
} satisfies UserConversationIndex;

describe("contracts: shapes", () => {
  it("wire, index and config shapes compile and carry the fixed values", () => {
    expect(request.messages).toHaveLength(3);
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(response.choices[0]?.finish_reason).toBe("stop");
    expect(index.actors["1"]?.role).toBe("parent");
    expect(asHarnessConfig).toBeTypeOf("function");
    expect(PI_SCHEMA_PREFIX).toBe("pi_");
    expect(APP_ATTRIBUTION.name).toBe("hmwrk");
  });

  it("stubs are placeholders, not silent implementations", async () => {
    expect(() => mapMessagesToInput(request.messages)).toThrow(/Not implemented/);
    expect(() => chunkFromDelta({ id: "x", created: 0, model: "hmwrk" }, { role: "assistant" })).toThrow(/Not implemented/);
    expect(() => finishChunk({ id: "x", created: 0, model: "hmwrk" }, "stop")).toThrow(/Not implemented/);
    expect(() => finishReasonFromTurn({ status: "done", stopReason: "stop" })).toThrow(/Not implemented/);
    expect(() => toToolParameters({} as never)).toThrow(/Not implemented/);
    expect(() => createRoleResolver({ keys: { parentKey: "p", childKey: "c" } })).toThrow(/Not implemented/);
    await expect(openHarness({ dbPath: ":memory:", dataDir: ".", models: {
      read: { provider: "groq", modelId: "qwen/qwen3.8-27b" },
      verify: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
      chat: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
    } })).rejects.toThrow(/Not implemented/);
  });
});
