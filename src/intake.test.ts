/**
 * P1 integration: the screenshot intake over the wired app (SPEC §5.3).
 *
 * Everything is real except the models: temp SQLite + photo directory, boot wiring (`src/app.ts`),
 * the parent's `PhotoFiles` intake, V2's `readImages` client and A1's agent/tools. pi-ai's faux
 * providers answer from a queue, so the test pins the pieces the unit tests cannot:
 *
 * 1. a parent's attached picture is stored as `kind: screenshot` and the message points the agent
 *    at `parse_screenshot` (not `submit_check_in`);
 * 2. the agent calls the tool with the id the HTTP layer appended; the tool reads the real bytes,
 *    asks the faux vision model and returns the draft;
 * 3. **nothing is created**: the draft is text for the parent, confirmation would go through
 *    `manual_add_assignment`.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { createHmwrkApp, type HmwrkApp } from "./app.js";
import type { Config, ModelsConfig } from "./config/index.js";
import { makeTempDir, silentLogger, type TempDir } from "./durable/testkit.js";
import { PNG_BYTES } from "./store/testkit.js";

const KEYS = { parentKey: "parent-secret", childKey: "child-secret" };
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;

const DRAFT_JSON = JSON.stringify({
  assignments: [
    {
      subject: "Математика",
      due: "2026-11-25",
      items: [{ label: "№12" }, { label: "№13", note: "стр. 54" }],
    },
  ],
  warnings: [],
});

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

/** Text of one message (string content or text blocks). */
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((part) => part !== "")
    .join("\n");
}

function lastText(messages: readonly Message[], role: Message["role"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === role) return messageText(message);
  }
  return "";
}

let temp: TempDir;
let app: HmwrkApp;

/** What the scripted turn captured from the requests it answered. */
const captured = { userText: "", toolResult: "", photoId: "" };

beforeAll(async () => {
  temp = makeTempDir("hmwrk-intake-");

  const chat = fauxProvider({ provider: "faux-chat", models: [{ id: "faux-chat" }] });
  const read = fauxProvider({ provider: "faux-read", models: [{ id: "faux-read", input: ["text", "image"] }] });
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

  chat.setResponses([
    // Round 1: the agent takes the photo ids from the block the HTTP layer appended.
    (context: { messages: Message[] }) => {
      captured.userText = lastText(context.messages, "user");
      captured.photoId = /прикреплены фото: ([^\s,—]+)/.exec(captured.userText)?.[1] ?? "";
      return fauxAssistantMessage(
        [fauxToolCall("parse_screenshot", { photo_ids: [captured.photoId], hint: "дневник" })],
        { stopReason: "toolUse" },
      );
    },
    // Round 2: the draft reaches the model as text it can relay.
    (context: { messages: Message[] }) => {
      captured.toolResult = lastText(context.messages, "toolResult");
      return fauxAssistantMessage("Вот черновик из скриншота — подтвердите, и я создам задания.");
    },
  ]);
  read.setResponses([fauxAssistantMessage(fauxText(DRAFT_JSON))]);

  app = await createHmwrkApp({ config: testConfig(temp.dir), llm: { models, slots }, logger: silentLogger() });
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  temp?.remove();
});

describe("screenshot intake over HTTP (faux vision)", () => {
  it("stores the parent's screenshot as intake material and returns a draft, creating nothing", async () => {
    const response = await app.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEYS.parentKey}` },
      body: JSON.stringify({
        model: "hmwrk",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "вот скриншот дневника, занеси задания" },
              { type: "image_url", image_url: { url: PNG_DATA_URL } },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    expect(body.choices?.[0]?.message?.content).toContain("подтвердите");

    // 1. kind by role (SPEC §5.3): a parent's picture is a screenshot, not a check-in photo.
    const screenshots = await app.domain.repos.photos.listByKind("screenshot");
    expect(screenshots).toHaveLength(1);
    const screenshot = screenshots[0];
    if (screenshot === undefined) throw new Error("unreachable");
    expect(captured.photoId).toBe(screenshot.id);
    expect(await app.domain.photoFiles.exists(screenshot)).toBe(true);
    expect(captured.userText).toContain("parse_screenshot");
    expect(captured.userText).not.toContain("submit_check_in");

    // 2. the tool read the real bytes and asked the vision model: the draft is in the tool result.
    expect(captured.toolResult).toContain("«Математика»");
    expect(captured.toolResult).toContain("25.11.2026");
    expect(captured.toolResult).toContain("пункты (2 пункта): №12, №13 (стр. 54)");
    expect(captured.toolResult).toContain("дождись подтверждения");

    // 3. confirmation is creation (SPEC §5.3): the draft created nothing by itself.
    expect(await app.domain.repos.assignments.list()).toHaveLength(0);
  });
});
