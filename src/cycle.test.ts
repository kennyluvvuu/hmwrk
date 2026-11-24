/**
 * The M2 cycle over HTTP (I2): one integration test that walks the whole live path.
 *
 * Everything is real except the models: a temp SQLite file, the migrated domain, the durable
 * harness, the agent with its nine tools, the verify task, the SSE/JSON endpoint. `pi-ai`'s faux
 * provider answers from a script, one provider per slot (`src/faux.ts` explains why: the verify
 * task runs concurrently with the turn that spawned it).
 *
 * The walk:
 *
 * 1. parent adds an assignment (tool call) — the summary then appears in the next prompt;
 * 2. child reports it with a photo attached to the chat message — the photo is stored by the HTTP
 *    layer, the agent passes its id to `submit_check_in`, and the verify task starts;
 * 3. the draft verdict exists but the child does not see it; the parent does;
 * 4. the parent approves it — assignment `in_review → done`;
 * 5. a retried HTTP request with the same `X-Request-Id` runs no second model call.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  createModels,
  type FauxProviderHandle,
  type Message,
} from "@earendil-works/pi-ai";
import { createHmwrkApp, type HmwrkApp } from "./app.js";
import type { Config, ModelsConfig } from "./config/index.js";
import { makeTempDir, silentLogger, type TempDir } from "./durable/testkit.js";
import { PNG_BYTES } from "./store/testkit.js";

const KEYS = { parentKey: "parent-secret", childKey: "child-secret" };

/** A 1×1 PNG as OpenWebUI sends it: a `data:` URL inside an `image_url` part. */
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;

function testConfig(dataDir: string): Config {
  return {
    port: 0,
    dataDir,
    photosDir: join(dataDir, "photos"),
    dbPath: join(dataDir, "hmwrk.sqlite"),
    logLevel: "error",
    echo: false,
    faux: { enabled: false },
    models: {
      read: { provider: "groq", modelId: "qwen/qwen3.6-27b" },
      verify: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
      chat: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
    },
    modelsPath: join(dataDir, "models.json"),
    secrets: {},
    roles: KEYS,
  };
}

/** All text the model was handed: system prompt, user turns, tool results. */
function transcriptText(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * The system prompt the model actually saw: replay of the positional `pi.system` entries.
 *
 * pi-durable sends prompt sections as a **patch** (only what changed since the previous request,
 * which keeps provider prompt caches warm), so a single message's `content` is empty and the text
 * lives in `message.sections`. Replaying the patches in order reconstructs the current prompt —
 * exactly what the harness itself does before a request.
 */
function systemPromptText(messages: readonly Message[]): string {
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const patch = (message as unknown as { sections?: Record<string, string | null> }).sections;
    if (patch === undefined) continue;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) sections.delete(key);
      else sections.set(key, value);
    }
  }
  return [...sections.values()].join("\n");
}

/** Text of the last `toolResult` message (what a tool returned to the model). */
function lastToolResult(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "toolResult") return transcriptText([message]);
  }
  return "";
}

/** The last user message of a model request. */
function lastUserMessage(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "user") return transcriptText([message]);
  }
  return "";
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let temp: TempDir;
let app: HmwrkApp;
let chat: FauxProviderHandle;

/** Ids that later scripted tool calls need; filled as the cycle advances. */
const ids = { assignment: "", verification: "", photo: "" };

/** What scripted response factories captured from the model requests. */
const captured = { summaryPrompt: "", parentVerdicts: "", childVerdicts: "" };

beforeAll(async () => {
  temp = makeTempDir("hmwrk-cycle-");

  chat = fauxProvider({ provider: "faux-chat", models: [{ id: "faux-chat" }] });
  const read = fauxProvider({
    provider: "faux-read",
    models: [{ id: "faux-read", input: ["text", "image"] }],
  });
  const verify = fauxProvider({ provider: "faux-verify", models: [{ id: "faux-verify" }] });

  const models = createModels();
  models.setProvider(chat.provider);
  models.setProvider(read.provider);
  models.setProvider(verify.provider);

  const slots = {
    read: { provider: "faux-read", modelId: "faux-read" },
    verify: { provider: "faux-verify", modelId: "faux-verify" },
    chat: { provider: "faux-chat", modelId: "faux-chat" },
  } as unknown as ModelsConfig;

  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  /** The child's report: the tool call needs the photo id the HTTP layer appended to the message. */
  const checkInStep = (context: { messages: Message[] }) => {
    const attached = /прикреплены фото: ([^\s,—]+)/.exec(lastUserMessage(context.messages));
    ids.photo = attached?.[1] ?? "";
    return fauxAssistantMessage(
      [
        fauxToolCall("submit_check_in", {
          assignment_id: ids.assignment,
          photo_ids: [ids.photo],
          comment: "сделал, № 13 не уверен",
        }),
      ],
      { stopReason: "toolUse" },
    );
  };

  chat.setResponses([
    // turn 1, round 1: the parent asks for an assignment → tool call
    fauxAssistantMessage(
      [
        fauxToolCall("manual_add_assignment", {
          subject: "Математика",
          items: ["№ 12", "№ 13"],
          due_at: dueAt,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    // turn 1, round 2: the final answer
    fauxAssistantMessage("Готово: добавил «Математика» с двумя пунктами."),
    // turn 2: the parent asks «что задано?» — capture the system prompt it was rendered with
    (context: { messages: Message[] }) => {
      captured.summaryPrompt = systemPromptText(context.messages);
      return fauxAssistantMessage("В работе «Математика», два пункта.");
    },
    // turn 3, round 1: the child reports with a photo attached to the message
    checkInStep as never,
    // turn 3, round 2
    fauxAssistantMessage("Отчёт принят, проверка запущена."),
    // turn 4: parent asks for verdicts (drafts included)
    fauxAssistantMessage([fauxToolCall("get_verdicts", {})], { stopReason: "toolUse" }),
    (context: { messages: Message[] }) => {
      captured.parentVerdicts = lastToolResult(context.messages);
      return fauxAssistantMessage("Черновик вердикта ждёт вашего утверждения.");
    },
    // turn 5: child asks for verdicts (approved only)
    fauxAssistantMessage([fauxToolCall("get_verdicts", {})], { stopReason: "toolUse" }),
    (context: { messages: Message[] }) => {
      captured.childVerdicts = lastToolResult(context.messages);
      return fauxAssistantMessage("Утверждённых вердиктов пока нет.");
    },
    // turn 6: parent approves
    () =>
      fauxAssistantMessage([fauxToolCall("approve_verification", { verification_id: ids.verification })], {
        stopReason: "toolUse",
      }),
    fauxAssistantMessage("Утвердил: «Математика» сдана."),
    // turn 7 (and the idempotent retry): a plain answer
    fauxAssistantMessage("Одно активное задание — «Математика»."),
  ]);

  const readResponse = fauxAssistantMessage(
    fauxText("№ 12: 5 + 7 = 12\n№ 13: видно только «13», без решения"),
  );
  read.setResponses([readResponse]);
  verify.setResponses([
    fauxAssistantMessage(
      JSON.stringify({
        items: [
          { label: "№ 12", verdict: "ok", comment: "решение верное" },
          { label: "№ 13", verdict: "missing", comment: "решения нет" },
        ],
        summary: "№ 12 решено верно, № 13 не решено.",
      }),
    ),
  ]);

  app = await createHmwrkApp({
    config: testConfig(temp.dir),
    llm: { models, slots },
    logger: silentLogger(),
  });
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  temp?.remove();
});

interface AskOptions {
  readonly key?: string;
  readonly content?: unknown;
  readonly headers?: Record<string, string>;
}

/** One `POST /v1/chat/completions` against the app, with the parent key by default. */
async function ask(text: string, options: AskOptions = {}): Promise<{ status: number; body: unknown }> {
  const response = await app.app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.key ?? KEYS.parentKey}`,
      ...options.headers,
    },
    body: JSON.stringify({
      model: "hmwrk",
      messages: [{ role: "user", content: options.content ?? text }],
    }),
  });
  return { status: response.status, body: await response.json() };
}

/** The assistant text of a non-streaming answer. */
function answerText(body: unknown): string {
  const parsed = body as { choices?: { message?: { content?: string } }[] };
  return parsed.choices?.[0]?.message?.content ?? "";
}

describe("M2 cycle over HTTP (faux models)", () => {
  it("runs add → summary → report with photo → draft verdict → approve → done", async () => {
    // 1. parent adds an assignment through the agent's tool
    const added = await ask("добавь задание по математике на завтра: № 12 и № 13");
    expect(added.status).toBe(200);
    expect(answerText(added.body)).toContain("Математика");

    const assignments = await app.domain.repos.assignments.list();
    expect(assignments).toHaveLength(1);
    ids.assignment = assignments[0]?.id ?? "";
    expect(ids.assignment).not.toBe("");

    // 2. the next prompt carries the summary (SPEC §6), rendered by the real extension
    const listed = await ask("что задано?");
    expect(listed.status).toBe(200);
    expect(captured.summaryPrompt).toContain("# Активные задания");
    expect(captured.summaryPrompt).toContain("Математика");
    expect(captured.summaryPrompt).toContain("ждёт отчёта");

    // 3. the child reports with a photo attached to the chat message
    const reported = await ask("сделал, фото тетради прикладываю", {
      key: KEYS.childKey,
      content: [
        { type: "text", text: "сделал, фото тетради прикладываю" },
        { type: "image_url", image_url: { url: PNG_DATA_URL } },
      ],
    });
    expect(reported.status).toBe(200);
    expect(answerText(reported.body)).toContain("Отчёт принят");
    expect(ids.photo).not.toBe("");

    // the photo reached the store as a check-in photo, with the bytes on disk
    const photo = await app.domain.repos.photos.get(ids.photo);
    expect(photo).toMatchObject({ kind: "checkin", mime: "image/png" });
    if (photo === null) throw new Error("unreachable");
    expect(await app.domain.photoFiles.exists(photo)).toBe(true);

    // the report moved the assignment to review and linked the photo
    const checkIn = await app.domain.repos.checkIns.latestForAssignment(ids.assignment);
    expect(checkIn).not.toBeNull();
    if (checkIn === null) throw new Error("unreachable");
    expect(await app.domain.repos.photos.listByCheckIn(checkIn.id)).toHaveLength(1);
    expect((await app.domain.repos.assignments.get(ids.assignment))?.status).toBe("in_review");

    // 4. the verify task ran and stored a draft
    const draft = await waitFor(async () => {
      const drafts = await app.domain.repos.verifications.listDrafts();
      return drafts[0];
    });
    ids.verification = draft.id;
    const withFindings = await app.domain.repos.verifications.getWithFindings(draft.id);
    expect(withFindings?.findings.map((finding) => finding.verdict)).toEqual(["ok", "missing"]);
    expect(withFindings?.summary).toContain("№ 12");

    // 5. the parent sees the draft, the child does not
    const parentView = await ask("что там по проверке?");
    expect(parentView.status).toBe(200);
    expect(captured.parentVerdicts).toContain(ids.verification);
    expect(captured.parentVerdicts).toContain("черновик");

    const childView = await ask("проверили мою работу?", { key: KEYS.childKey });
    expect(childView.status).toBe(200);
    expect(captured.childVerdicts).toContain("Утверждённых вердиктов пока нет");
    expect(captured.childVerdicts).not.toContain(ids.verification);

    // 6. approving makes it final and the assignment done
    const approved = await ask("да, всё верно, утверждаю");
    expect(approved.status).toBe(200);
    expect(answerText(approved.body)).toContain("сдана");

    expect((await app.domain.repos.verifications.get(ids.verification))?.status).toBe("approved");
    expect((await app.domain.repos.assignments.get(ids.assignment))?.status).toBe("done");
  }, 30_000);

  it("does not run a second model call for a retried request with the same X-Request-Id", async () => {
    const headers = { "x-request-id": "retry-me-1" };
    const before = chat.state.callCount;

    const first = await ask("что у нас в работе?", { headers });
    expect(first.status).toBe(200);
    const afterFirst = chat.state.callCount;
    expect(afterFirst).toBe(before + 1);

    const retry = await ask("что у нас в работе?", { headers });
    expect(retry.status).toBe(200);
    expect(answerText(retry.body)).toBe(answerText(first.body));
    // K4: the same requestId returns the same submission — no second run, no second model call.
    expect(chat.state.callCount).toBe(afterFirst);
  }, 30_000);
});
