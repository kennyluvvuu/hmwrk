import { describe, expect, it } from "vitest";
import { createInMemoryRepos } from "../domain/fakes.js";
import { chatIdsOf, escapeHtml, resolveUserChatId, resolveUserChats } from "./bindings.js";

async function seed() {
  const repos = createInMemoryRepos();
  const parent = await repos.users.create({ openwebui_user_id: "owui-parent", role: "parent", name: "Мама" });
  const child = await repos.users.create({ openwebui_user_id: "owui-child", role: "child", name: "Петя" });
  return { repos, parent, child };
}

describe("escapeHtml", () => {
  it("escapes the three characters Telegram's HTML mode treats as markup", () => {
    expect(escapeHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("escapes ampersands first, so entities are not double-decoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves quotes and unicode alone (text context, no attributes)", () => {
    expect(escapeHtml(`"кавычки" 'одинарные' — тире`)).toBe(`"кавычки" 'одинарные' — тире`);
  });
});

describe("resolveUserChatId", () => {
  it("returns null when no user is bound", async () => {
    const { repos, child } = await seed();
    expect(await resolveUserChatId(repos.tgBindings, [child])).toBeNull();
    expect(await resolveUserChatId(repos.tgBindings, [])).toBeNull();
  });

  it("returns the chat of the first bound user in list order", async () => {
    const { repos, parent, child } = await seed();
    await repos.tgBindings.upsert({ user_id: child.id, chat_id: "222" });
    await repos.tgBindings.upsert({ user_id: parent.id, chat_id: "-111" });

    expect(await resolveUserChatId(repos.tgBindings, [parent, child])).toBe("-111");
    expect(await resolveUserChatId(repos.tgBindings, [child, parent])).toBe("222");
  });

  it("skips an unbound user in the middle of the list", async () => {
    const { repos, parent, child } = await seed();
    const sibling = await repos.users.create({ openwebui_user_id: "owui-2", role: "child", name: "Аня" });
    await repos.tgBindings.upsert({ user_id: sibling.id, chat_id: "333" });

    expect(await resolveUserChatId(repos.tgBindings, [parent, sibling, child])).toBe("333");
  });
});

describe("resolveUserChats", () => {
  it("returns every binding with its user id, in list order", async () => {
    const { repos, parent, child } = await seed();
    await repos.tgBindings.upsert({ user_id: parent.id, chat_id: "-111" });
    await repos.tgBindings.upsert({ user_id: child.id, chat_id: "222" });

    expect(await resolveUserChats(repos.tgBindings, [child, parent])).toEqual([
      { userId: child.id, chatId: "222" },
      { userId: parent.id, chatId: "-111" },
    ]);
  });

  it("returns an empty list when nothing is bound", async () => {
    const { repos, parent, child } = await seed();
    expect(await resolveUserChats(repos.tgBindings, [parent, child])).toEqual([]);
  });
});

describe("chatIdsOf", () => {
  it("deduplicates chat ids and keeps order", () => {
    const bindings = [
      { user_id: "u1", chat_id: "1", created_at: "2026-11-24T10:00:00.000Z" },
      { user_id: "u2", chat_id: "1", created_at: "2026-11-24T10:01:00.000Z" },
      { user_id: "u3", chat_id: "2", created_at: "2026-11-24T10:02:00.000Z" },
    ];

    expect(chatIdsOf(bindings)).toEqual(["1", "2"]);
  });
});
