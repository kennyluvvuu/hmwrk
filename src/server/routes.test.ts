import { describe, expect, it } from "vitest";
import type { ChatCompletionChunk, OpenAIModelList } from "../contracts/openai.js";
import { PNG_BYTES } from "../store/testkit.js";
import { createRoleResolver } from "./auth.js";
import { createApp, deriveRequestId } from "./routes.js";
import { createFakeCore, type FakeCore } from "./testing/fake-core.js";

const keys = { parentKey: "parent-secret", childKey: "child-secret" };
const FIXED_NOW = 1_700_000_000_000; // fixed clock: `created` must be deterministic

function setup(): { core: FakeCore; request: (path: string, init?: RequestInit) => Promise<Response> } {
  const core = createFakeCore();
  const app = createApp({
    core,
    resolver: createRoleResolver({ keys }),
    now: () => FIXED_NOW,
  });
  return { core, request: (path, init) => Promise.resolve(app.request(path, init)) };
}

function chatBody(overrides: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.parentKey}` },
    body: JSON.stringify({
      model: "hmwrk",
      messages: [{ role: "user", content: "математика №12" }],
      ...overrides,
    }),
  };
}

/** Splits an SSE body into `data:` payloads; the last one is expected to be `[DONE]`. */
function parseSse(text: string): { payloads: string[]; done: boolean } {
  const frames = text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame !== "");
  const payloads = frames.map((frame) => {
    expect(frame.startsWith("data: ")).toBe(true);
    return frame.slice("data: ".length);
  });
  const done = payloads.at(-1) === "[DONE]";
  return { payloads: done ? payloads.slice(0, -1) : payloads, done };
}

describe("auth middleware", () => {
  it("answers 401 with an OpenAI-shaped error when no key is sent", async () => {
    const { request } = setup();
    const res = await request("/v1/models");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string; type: string; code: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("missing_credentials");
  });

  it("rejects an unknown key on the chat endpoint", async () => {
    const { request } = setup();
    const res = await request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ model: "hmwrk", messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_credentials");
  });
});

describe("GET /healthz and GET /v1/models", () => {
  it("serves the liveness probe without auth", async () => {
    const { request } = setup();
    const res = await request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("lists exactly one model, hmwrk", async () => {
    const { request } = setup();
    const res = await request("/v1/models", { headers: { authorization: `Bearer ${keys.childKey}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpenAIModelList;
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: "hmwrk", object: "model", owned_by: "hmwrk" });
  });
});

describe("POST /v1/chat/completions without stream (M1 echo)", () => {
  it("answers with a chat.completion carrying the echoed text", async () => {
    const { core, request } = setup();
    const res = await request("/v1/chat/completions", chatBody());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: string;
      object: string;
      model: string;
      created: number;
      choices: { index: number; message: { role: string; content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("hmwrk");
    expect(body.created).toBe(FIXED_NOW / 1000);
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]?.message).toEqual({ role: "assistant", content: "математика №12" });
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(0);

    expect(core.echoes).toHaveLength(1);
    expect(core.echoes[0]?.text).toBe("математика №12");
  });

  it("binds the key to the parent role and a stable user id", async () => {
    const { core, request } = setup();
    await request("/v1/chat/completions", chatBody());
    const conversation = core.conversations.get("key:parent");
    expect(conversation?.role).toBe("parent");
    expect(core.echoes[0]?.userId).toBe("key:parent");
  });

  it("rejects a request whose last user message has no text", async () => {
    const { request } = setup();
    const res = await request("/v1/chat/completions", chatBody({ messages: [{ role: "user", content: "" }] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("empty_message");
  });

  it("rejects a body that is not JSON", async () => {
    const { request } = setup();
    const res = await request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${keys.parentKey}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/chat/completions with stream (K5 SSE)", () => {
  it("sends SSE headers", async () => {
    const { request } = setup();
    const res = await request("/v1/chat/completions", chatBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(res.headers.get("connection")).toBe("keep-alive");
  });

  it("emits role delta → content deltas → finish chunk → [DONE]", async () => {
    const { request } = setup();
    const res = await request("/v1/chat/completions", chatBody({ stream: true }));
    const { payloads, done } = parseSse(await res.text());
    expect(done).toBe(true);

    const chunks = payloads.map((payload) => JSON.parse(payload) as ChatCompletionChunk);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    // Every chunk is a well-formed chat.completion.chunk of one response.
    for (const chunk of chunks) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.model).toBe("hmwrk");
      expect(chunk.id).toBe(chunks[0]?.id);
      expect(chunk.choices[0]?.index).toBe(0);
    }

    // 1. the opening role delta
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
    expect(chunks[0]?.choices[0]?.finish_reason).toBeNull();

    // 2. content deltas, in order, that join back to the echo
    const contentChunks = chunks.slice(1, -1);
    expect(contentChunks.length).toBeGreaterThan(0);
    for (const chunk of contentChunks) {
      expect(chunk.choices[0]?.finish_reason).toBeNull();
      expect(typeof chunk.choices[0]?.delta.content).toBe("string");
    }
    expect(contentChunks.map((chunk) => chunk.choices[0]?.delta.content).join("")).toBe("математика №12");

    // 3. the finish chunk carries the reason and usage
    const last = chunks.at(-1);
    expect(last?.choices[0]?.delta).toEqual({});
    expect(last?.choices[0]?.finish_reason).toBe("stop");
    expect(last?.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("surfaces a core failure as an error payload, then [DONE]", async () => {
    const core = createFakeCore();
    const failing = {
      ...core,
      echo: async () => {
        throw new Error("durable exploded");
      },
    };
    const app = createApp({ core: failing, resolver: createRoleResolver({ keys }), now: () => FIXED_NOW });
    const res = await app.request("/v1/chat/completions", chatBody({ stream: true }));
    const { payloads, done } = parseSse(await res.text());
    expect(done).toBe(true);
    const error = JSON.parse(payloads.at(-1) ?? "{}") as { error: { type: string; message: string } };
    expect(error.error).toEqual({ type: "server_error", code: null, message: "durable exploded" });
  });
});

describe("one key = one durable conversation", () => {
  it("gives two different keys two different users and conversations", async () => {
    const { core, request } = setup();

    await request("/v1/chat/completions", chatBody());
    await request("/v1/chat/completions", {
      ...chatBody(),
      headers: { "content-type": "application/json", authorization: `Bearer ${keys.childKey}` },
    });
    await request("/v1/chat/completions", chatBody());

    expect([...core.conversations.keys()].sort()).toEqual(["key:child", "key:parent"]);
    const parentConversation = core.conversations.get("key:parent");
    const childConversation = core.conversations.get("key:child");
    expect(parentConversation?.id).not.toBe(childConversation?.id);
    expect(core.calls.getOrCreateConversation).toBe(3);
    expect(core.conversationCount()).toBe(2);

    // The repeated parent request reused the same conversation, not a new one.
    expect(core.echoes.map((echo) => echo.conversationId)).toEqual([
      parentConversation?.id,
      childConversation?.id,
      parentConversation?.id,
    ]);
    expect(core.echoes[1]?.role).toBe("child");
  });
});

describe("durable idempotency key (K4)", () => {
  const actor = { userId: "key:parent", role: "parent" as const, via: "api-key" as const };
  const request = { model: "hmwrk", messages: [{ role: "user" as const, content: "что задано?" }] };

  it("uses the X-Request-Id header when the client sends one", () => {
    expect(deriveRequestId("  req-42 ", actor, request)).toBe("req-42");
  });

  it("derives a stable key from actor + model + messages when no header is sent", () => {
    const first = deriveRequestId(undefined, actor, request);
    const second = deriveRequestId("", actor, request);
    expect(first).toBe(second);
    expect(first).toMatch(/^auto-[0-9a-f]{40}$/);
  });

  it("separates different actors and different messages", () => {
    const other = deriveRequestId(undefined, { ...actor, userId: "key:child" }, request);
    const changed = deriveRequestId(undefined, actor, {
      ...request,
      messages: [{ role: "user", content: "что задано завтра?" }],
    });
    expect(other).not.toBe(deriveRequestId(undefined, actor, request));
    expect(changed).not.toBe(deriveRequestId(undefined, actor, request));
  });
});

describe("photos attached to a chat message (SPEC §5.4)", () => {
  const PNG_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;

  function setupWithPhotos(key: string = keys.childKey): {
    core: FakeCore;
    saved: { kind: string; mime?: string }[];
    request: (body: unknown) => Promise<Response>;
  } {
    const core = createFakeCore();
    const saved: { kind: string; mime?: string }[] = [];
    let next = 0;
    const app = createApp({
      core,
      resolver: createRoleResolver({ keys }),
      now: () => FIXED_NOW,
      photoIntake: {
        async save(input) {
          saved.push({ kind: input.kind, ...(input.mime === undefined ? {} : { mime: input.mime }) });
          next += 1;
          return { id: `photo-${next}` };
        },
      },
    });
    return {
      core,
      saved,
      request: (body) =>
        Promise.resolve(
          app.request("/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
          }),
        ),
    };
  }

  it("stores the image and appends its id to the submitted text", async () => {
    const { core, saved, request } = setupWithPhotos();
    const res = await request({
      model: "hmwrk",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "сделал, фото прикладываю" },
            { type: "image_url", image_url: { url: PNG_URL } },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(saved).toEqual([{ kind: "checkin", mime: "image/png" }]);
    expect(String(core.echoes[0]?.input)).toContain("photo-1");
    expect(String(core.echoes[0]?.input)).toContain("submit_check_in");
  });

  it("a parent's screenshot is stored as intake material and pointed at parse_screenshot (P1)", async () => {
    const { core, saved, request } = setupWithPhotos(keys.parentKey);
    const res = await request({
      model: "hmwrk",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "вот скриншот дневника" },
            { type: "image_url", image_url: { url: PNG_URL } },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(saved).toEqual([{ kind: "screenshot", mime: "image/png" }]);
    expect(String(core.echoes[0]?.input)).toContain("parse_screenshot");
    expect(String(core.echoes[0]?.input)).not.toContain("submit_check_in");
  });

  it("still answers when the image part is broken", async () => {
    const { core, request } = setupWithPhotos();
    const res = await request({
      model: "hmwrk",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "вот фото" },
            { type: "image_url", image_url: { url: "https://example.test/photo.jpg" } },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    // Nothing was attached, so the text is submitted unchanged.
    expect(core.echoes[0]?.input).toBe("вот фото");
  });
});
