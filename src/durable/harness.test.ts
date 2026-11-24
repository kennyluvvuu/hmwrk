/**
 * S1: opening, durability and graceful close of the facade (M1 scope).
 *
 * Everything runs on a temp SQLite file and pi-ai's faux provider — no network, no real model (R1 K6).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHarness, type Core } from "../contracts/harness.js";
import {
  buildModels,
  installExtensions,
  openHarnessCore,
  registryFor,
  shutdown,
} from "./harness.js";
import { makeTempDir, fauxModels, silentLogger, testConfig, type TempDir } from "./testkit.js";

let temp: TempDir;
let core: Core | undefined;

beforeEach(() => {
  temp = makeTempDir();
});

afterEach(async () => {
  if (core !== undefined) {
    await core.close().catch(() => undefined);
    core = undefined;
  }
  temp.remove();
});

describe("openHarness", () => {
  it("opens on a temp SQLite file and gives each user its own conversation", async () => {
    const { models } = fauxModels();
    core = await openHarness(testConfig(temp.dir), { models, logger: silentLogger() });
    await core.resume();

    const parent = await core.getOrCreateConversation("key:parent", "parent");
    const child = await core.getOrCreateConversation("key:child", "child");

    expect(parent.id).not.toBe(child.id);
    expect(parent.role).toBe("parent");
    expect(child.role).toBe("child");

    // Echo writes the pair in one commit (K6), and the conversations stay independent.
    const echoed = await core.echo(child, "что задали по математике?");
    expect(echoed.text).toBe("что задали по математике?");
    expect(echoed.userEntryId).not.toBe(echoed.assistantEntryId);

    const childView = await child.handle.context(BACKGROUND_CONTEXT);
    expect(childView.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);

    const parentView = await parent.handle.context(BACKGROUND_CONTEXT);
    expect(parentView.entries).toHaveLength(0);

    // The prefix is the contract's: durable tables live beside future domain tables in the same file (K2).
    const tables = await core.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.map((table) => table.name);
    expect(names).toContain("pi_conversations");
    expect(names).toContain("pi_entries");
    expect(names).toContain("pi_documents");
    expect(names.every((name) => name.startsWith("pi_") || name.startsWith("sqlite_"))).toBe(true);
  });

  it("keeps the same conversation and its history across close and reopen (K3 pattern)", async () => {
    const cfg = testConfig(temp.dir);
    const first = fauxModels();
    const opened = await openHarness(cfg, { models: first.models, logger: silentLogger() });
    await opened.resume();

    const conversation = await opened.getOrCreateConversation("key:parent", "parent");
    await opened.echo(conversation, "первое сообщение");
    await opened.echo(conversation, "второе сообщение");
    const before = await conversation.handle.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
    expect(before.items).toHaveLength(4);
    const idBefore = conversation.id;
    await opened.close();

    // Reopen the same file with a fresh core, as a process restart would.
    const second = fauxModels();
    core = await openHarness(cfg, { models: second.models, logger: silentLogger() });
    await core.resume();

    const reopened = await core.getOrCreateConversation("key:parent", "parent");
    expect(reopened.id).toBe(idBefore);

    const after = await reopened.handle.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
    expect(after.items.map((entry) => entry.kind)).toEqual([
      "pi.user",
      "pi.assistant",
      "pi.user",
      "pi.assistant",
    ]);
    expect(after.items[1]?.model?.[0]).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(after.items)).toContain("первое сообщение");

    // Actors survive too: A1's prompt section reads the role from the mapping document.
    expect(await core.actors.get(reopened.id)).toEqual({ userId: "key:parent", role: "parent" });
    expect(await core.conversation("key:parent")).toMatchObject({ id: idBefore, role: "parent" });
  });

  it("resumes work after a close that interrupted a run (K11 restart continuation)", async () => {
    const cfg = testConfig(temp.dir);
    const first = fauxModels({ tokensPerSecond: 20 });
    const opened = await openHarnessCore(cfg, { models: first.models, logger: silentLogger() });
    await opened.resume();

    const conversation = await opened.getOrCreateConversation("key:child", "child");

    // A long scripted answer: the run is still streaming when close() seals admission.
    first.faux.setResponses([fauxAssistantMessage(`длинный ответ ${"и ещё слова ".repeat(40)}`)]);
    const pending = await opened.submitUserInput(conversation, "долгий вопрос");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await opened.close();
    await pending.settle().then(
      () => undefined,
      () => undefined,
    );

    // Reopen: the conversation, its transcript and the admitted input are all there; a new turn works.
    const second = fauxModels();
    core = await openHarnessCore(cfg, { models: second.models, logger: silentLogger() });
    await core.resume();

    const reopened = await core.getOrCreateConversation("key:child", "child");
    expect(reopened.id).toBe(conversation.id);

    // A run that close() stopped is sent again on the next resume (K11); let it finish before a new turn.
    second.faux.setResponses([fauxAssistantMessage("переигранный ответ")]);
    await core.harness.waitForIdle(BACKGROUND_CONTEXT);

    second.faux.setResponses([fauxAssistantMessage("ответ после рестарта")]);
    const result = await (await core.submitUserInput(reopened, "вопрос после рестарта")).settle();
    expect(result.status).toBe("done");
    expect(result.text).toBe("ответ после рестарта");

    const transcript = await reopened.handle.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(transcript.items)).toContain("долгий вопрос");
    expect(JSON.stringify(transcript.items)).toContain("ответ после рестарта");
  }, 20_000);

  it("shutdown() closes once, is idempotent and is safe to call twice", async () => {
    const { models } = fauxModels();
    const opened = await openHarnessCore(testConfig(temp.dir), { models, logger: silentLogger() });
    await opened.resume();
    await opened.getOrCreateConversation("key:parent", "parent");

    const failures: number[] = [];
    const first = shutdown(opened, { hardExit: (code) => failures.push(code) });
    const second = shutdown(opened, { hardExit: (code) => failures.push(code) });
    expect(second).toBe(first);
    await first;
    expect(failures).toEqual([]);
    await expect(opened.close()).resolves.toBeUndefined();
    // The temp dir can only be removed if the SQLite file was closed.
    expect(existsSync(join(temp.dir, "hmwrk.sqlite"))).toBe(true);
  });

  it("stores durable state in its own file when asked for the separate-file layout", async () => {
    const cfg = testConfig(temp.dir);
    const durableDbPath = join(temp.dir, "durable.sqlite");
    const { models } = fauxModels();
    core = await openHarness(cfg, {
      models,
      logger: silentLogger(),
      storage: { kind: "separate-file", durableDbPath },
    });
    await core.resume();
    await core.echo(await core.getOrCreateConversation("key:parent", "parent"), "в отдельном файле");

    expect(existsSync(durableDbPath)).toBe(true);
    expect(existsSync(cfg.dbPath)).toBe(false);
  });

  it("installs agent extensions into the live registry (A1/M2 seam)", async () => {
    const { models } = fauxModels();
    core = await openHarnessCore(testConfig(temp.dir), { models, logger: silentLogger() });

    const extension = defineExtension({ name: "test-agent-section" });
    installExtensions(core, [extension]);

    expect(registryFor(core).snapshot().extension("test-agent-section")).toBeDefined();
    expect(registryFor(core).snapshot().installed().map((installed) => installed.name)).toContain(
      "test-agent-section",
    );
  });

  it("builds the groq/mistral catalogue without any API key (K8: absent keys are not fatal in M1)", () => {
    const models = buildModels();
    expect(models.getProvider("groq")).toBeDefined();
    expect(models.getProvider("mistral")).toBeDefined();
    // Catalogue lookups are local: the ids come from models.json, the keys are only needed to call out.
    expect(models.getModel("mistral", "deepseek-v4-1-flash-1017")).toBeDefined();
  });
});
