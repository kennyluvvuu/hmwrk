/**
 * Bind logic (fake repos) plus the real `scripts/bind-telegram.ts` against a temp SQLite file.
 *
 * The script test imports the script module and calls `runBindScript` with an explicit `DATA_DIR`,
 * so the whole path — env parsing, `openDomain`, migration, role lookup, `tg_bindings` write — runs
 * for real. Nothing touches the network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryRepos } from "../domain/fakes.js";
import { createLogger } from "../config/logger.js";
import { openDomain } from "../store/index.js";
import { parseBindArgs, runBindScript } from "../../scripts/bind-telegram.js";
import { bindRoleChat, parseChatId, parseRole } from "./bind.js";

const ENV = {
  DATA_DIR: "",
  HMWRK_PARENT_KEY: "parent-secret",
  HMWRK_CHILD_KEY: "child-secret",
};
const silent = () => createLogger({ level: "error", sink: () => {} });
const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "hmwrk-bind-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseRole / parseChatId", () => {
  it("accepts the two roles and numeric, negative and @channel chat ids", () => {
    expect(parseRole("parent")).toBe("parent");
    expect(parseRole("child")).toBe("child");
    expect(parseChatId("123456789")).toBe("123456789");
    expect(parseChatId(" -1001234567890 ")).toBe("-1001234567890");
    expect(parseChatId("@hmwrk_family")).toBe("@hmwrk_family");
  });

  it("rejects typos and garbage before anything is written", () => {
    expect(() => parseRole("Parent")).toThrow(/must be "parent" or "child"/);
    expect(() => parseChatId("")).toThrow(/chat id must be numeric/);
    expect(() => parseChatId("12 34")).toThrow(/chat id must be numeric/);
    expect(() => parseChatId("@ab")).toThrow(/chat id must be numeric/);
  });
});

describe("bindRoleChat (fakes)", () => {
  it("upserts the binding for the single user of the role", async () => {
    const repos = createInMemoryRepos();
    const parent = await repos.users.create({ openwebui_user_id: "owui-p", role: "parent", name: "Мама" });

    const result = await bindRoleChat(repos, { role: "parent", chatId: "111" });

    expect(result.binding).toEqual({ user_id: parent.id, chat_id: "111", created_at: expect.any(String) });
    expect(result.userName).toBe("Мама");
    expect(await repos.tgBindings.getByUserId(parent.id)).toMatchObject({ chat_id: "111" });
  });

  it("re-points an existing binding instead of adding a second row", async () => {
    const repos = createInMemoryRepos();
    await repos.users.create({ openwebui_user_id: "owui-c", role: "child", name: "Петя" });

    await bindRoleChat(repos, { role: "child", chatId: "1" });
    await bindRoleChat(repos, { role: "child", chatId: "2" });

    expect(await repos.tgBindings.list()).toHaveLength(1);
    expect((await repos.tgBindings.list())[0]?.chat_id).toBe("2");
  });

  it("explains what to do when the role has no user yet", async () => {
    const repos = createInMemoryRepos();
    await expect(bindRoleChat(repos, { role: "child", chatId: "1" })).rejects.toThrow(
      /no user with role "child": log in to OpenWebUI/,
    );
  });

  it("refuses to guess between two users of the same role", async () => {
    const repos = createInMemoryRepos();
    await repos.users.create({ openwebui_user_id: "owui-1", role: "parent", name: "Мама" });
    await repos.users.create({ openwebui_user_id: "owui-2", role: "parent", name: "Папа" });

    await expect(bindRoleChat(repos, { role: "parent", chatId: "1" })).rejects.toThrow(
      /2 users have role "parent"/,
    );
    expect(await repos.tgBindings.list()).toEqual([]);
  });
});

describe("scripts/bind-telegram.ts", () => {
  it("parses exactly two positional arguments", () => {
    expect(parseBindArgs(["parent", "123"])).toEqual({ role: "parent", chatId: "123" });
    expect(() => parseBindArgs([])).toThrow(/usage:/);
    expect(() => parseBindArgs(["parent", "1", "2"])).toThrow(/usage:/);
  });

  it("binds a chat in the DATA_DIR SQLite file (smoke)", async () => {
    const dataDir = scratch();
    const env = { ...ENV, DATA_DIR: dataDir };

    // Seed the users row the way a first OpenWebUI login would.
    const seedDb = await openNodeSqliteDatabase(join(dataDir, "hmwrk.sqlite"));
    const seed = openDomain({ db: seedDb, dataDir });
    await seed.migrate();
    const parent = await seed.repos.users.create({
      openwebui_user_id: "owui-parent",
      role: "parent",
      name: "Мама",
    });
    await seedDb.close();

    const result = await runBindScript({ argv: ["parent", "-100500"], env, logger: silent() });

    expect(result).toMatchObject({ role: "parent", chatId: "-100500", userId: parent.id, userName: "Мама" });
    expect(result.dbPath).toBe(join(dataDir, "hmwrk.sqlite"));

    const checkDb = await openNodeSqliteDatabase(result.dbPath);
    const check = openDomain({ db: checkDb, dataDir });
    try {
      expect(await check.repos.tgBindings.getByUserId(parent.id)).toMatchObject({ chat_id: "-100500" });
    } finally {
      await checkDb.close();
    }
  });

  it("fails fast on a bad role without creating a database", async () => {
    const dataDir = scratch();
    const env = { ...ENV, DATA_DIR: dataDir };

    await expect(runBindScript({ argv: ["parent", "1", "--force"], env, logger: silent() })).rejects.toThrow(
      /usage:/,
    );
    await expect(runBindScript({ argv: ["grandma", "1"], env, logger: silent() })).rejects.toThrow(
      /must be "parent" or "child"/,
    );
  });
});
