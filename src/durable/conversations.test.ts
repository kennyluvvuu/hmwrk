/**
 * S1: the user → conversation mapping (R1 K3) and the actor directory A1 reads.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHarness, type Core } from "../contracts/harness.js";
import { readUserConversationIndex } from "./conversations.js";
import { fauxModels, makeTempDir, silentLogger, testConfig, type TempDir } from "./testkit.js";

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

async function open(): Promise<Core> {
  const { models } = fauxModels();
  const opened = await openHarness(testConfig(temp.dir), { models, logger: silentLogger() });
  await opened.resume();
  return opened;
}

describe("conversations", () => {
  it("creates one conversation per user and returns it on every later call", async () => {
    core = await open();

    const first = await core.getOrCreateConversation("key:parent", "parent");
    const again = await core.getOrCreateConversation("key:parent", "parent");
    const other = await core.getOrCreateConversation("key:parent-2", "parent");

    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);

    // The mapping document holds both directions (K3): by user, and by conversation for the prompt section.
    const index = await readUserConversationIndex(core.harness, BACKGROUND_CONTEXT);
    expect(index.byUser).toEqual({ "key:parent": first.id, "key:parent-2": other.id });
    expect(index.actors[String(first.id)]).toEqual({ userId: "key:parent", role: "parent" });

    expect(await core.conversation("key:parent")).toMatchObject({ id: first.id, userId: "key:parent" });
    expect(await core.conversation("nobody")).toBeNull();
  });

  it("keeps a child's and a parent's conversations apart", async () => {
    core = await open();

    const parent = await core.getOrCreateConversation("key:parent", "parent");
    const child = await core.getOrCreateConversation("key:child", "child");

    await core.echo(parent, "папе: проверь тетрадь");

    const childView = await child.handle.context(BACKGROUND_CONTEXT);
    const parentView = await parent.handle.context(BACKGROUND_CONTEXT);
    expect(childView.entries).toHaveLength(0);
    expect(parentView.entries).toHaveLength(2);

    expect(await core.actors.get(parent.id)).toEqual({ userId: "key:parent", role: "parent" });
    expect(await core.actors.get(child.id)).toEqual({ userId: "key:child", role: "child" });
    // A conversation nobody created has no actor.
    expect(await core.actors.get((parent.id + 1000) as typeof parent.id)).toBeNull();
  });

  it("records a role change on the existing conversation instead of creating a second one", async () => {
    core = await open();

    const first = await core.getOrCreateConversation("key:telegram:42", "child");
    const changed = await core.getOrCreateConversation("key:telegram:42", "parent");

    expect(changed.id).toBe(first.id);
    expect(await core.actors.get(first.id)).toEqual({ userId: "key:telegram:42", role: "parent" });
    const index = await readUserConversationIndex(core.harness, BACKGROUND_CONTEXT);
    expect(Object.keys(index.byUser)).toEqual(["key:telegram:42"]);
  });

  it("configures a model on creation, so a run is possible without a second step (K3 gotcha)", async () => {
    core = await open();
    const conversation = await core.getOrCreateConversation("key:child", "child");

    const agent = await conversation.handle.agent(BACKGROUND_CONTEXT);
    expect(agent.model).toEqual({ provider: "mistral", modelId: "deepseek-v4-1-flash-1017" });
  });
});
