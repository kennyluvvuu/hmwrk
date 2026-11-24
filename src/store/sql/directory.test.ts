/**
 * D2: the small tables — `users`, `tg_bindings` and `settings` (SPEC §4, §5.6, §5.7).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDomain, type TestDomain } from "../testkit.js";

let store: TestDomain;

beforeEach(async () => {
  store = await openTestDomain();
});

afterEach(async () => {
  await store.close();
  store.remove();
});

describe("SqliteUsersRepo", () => {
  it("creates a user and resolves it by OpenWebUI id", async () => {
    const repos = store.domain.repos;
    const user = await repos.users.create({ openwebui_user_id: "ow-1", role: "parent", name: "Мама" });

    expect(user.role).toBe("parent");
    expect(await repos.users.get(user.id)).toEqual(user);
    expect(await repos.users.getByOpenWebUiId("ow-1")).toEqual(user);
    expect(await repos.users.get("nope")).toBeNull();
    expect(await repos.users.getByOpenWebUiId("nope")).toBeNull();
  });

  it("refuses a duplicate OpenWebUI account", async () => {
    const repos = store.domain.repos;
    await repos.users.create({ openwebui_user_id: "ow-1", role: "child", name: "Сын" });

    await expect(repos.users.create({ openwebui_user_id: "ow-1", role: "child", name: "Сын" })).rejects.toThrow(
      /already exists/,
    );
  });

  it("upsert syncs role and name without touching created_at", async () => {
    const repos = store.domain.repos;
    const created = await repos.users.create({ openwebui_user_id: "ow-1", role: "child", name: "Сын" });
    store.clock.current = new Date(store.clock.current.getTime() + 60_000);

    const updated = await repos.users.upsert({ openwebui_user_id: "ow-1", role: "parent", name: "Мама" });

    expect(updated.id).toBe(created.id);
    expect(updated.role).toBe("parent");
    expect(updated.name).toBe("Мама");
    expect(updated.created_at).toBe(created.created_at);
    expect(await repos.users.list()).toHaveLength(1);
  });

  it("upsert creates when the account is unknown", async () => {
    const repos = store.domain.repos;

    const user = await repos.users.upsert({ openwebui_user_id: "ow-new", role: "child", name: "Дочь" });

    expect(user.openwebui_user_id).toBe("ow-new");
    expect(await repos.users.list()).toHaveLength(1);
  });

  it("lists by role and changes a role", async () => {
    const repos = store.domain.repos;
    const parent = await repos.users.create({ openwebui_user_id: "ow-p", role: "parent", name: "Папа" });
    const child = await repos.users.create({ openwebui_user_id: "ow-c", role: "child", name: "Сын" });

    expect((await repos.users.listByRole("parent")).map((u) => u.id)).toEqual([parent.id]);
    expect((await repos.users.list()).map((u) => u.id)).toEqual([parent.id, child.id]);

    const promoted = await repos.users.setRole(child.id, "parent");
    expect(promoted.role).toBe("parent");
    expect((await repos.users.listByRole("child"))).toEqual([]);
    await expect(repos.users.setRole("nope", "child")).rejects.toThrow(/not found/);
  });
});

describe("SqliteTgBindingsRepo", () => {
  it("binds a chat, re-points it and keeps created_at", async () => {
    const repos = store.domain.repos;
    await repos.users.create({ openwebui_user_id: "ow-1", role: "parent", name: "Мама" });
    const user = await repos.users.getByOpenWebUiId("ow-1");
    if (user === null) throw new Error("user missing");

    const binding = await repos.tgBindings.upsert({ user_id: user.id, chat_id: "100" });
    store.clock.current = new Date(store.clock.current.getTime() + 60_000);
    const rebound = await repos.tgBindings.upsert({ user_id: user.id, chat_id: "200" });

    expect(rebound.chat_id).toBe("200");
    expect(rebound.created_at).toBe(binding.created_at);
    expect(await repos.tgBindings.getByUserId(user.id)).toEqual(rebound);
    expect(await repos.tgBindings.list()).toHaveLength(1);
    expect(await repos.tgBindings.getByUserId("nope")).toBeNull();
  });

  it("removes a binding and reports whether it existed", async () => {
    const repos = store.domain.repos;
    await repos.tgBindings.upsert({ user_id: "user-1", chat_id: "100" });

    expect(await repos.tgBindings.remove("user-1")).toBe(true);
    expect(await repos.tgBindings.remove("user-1")).toBe(false);
    expect(await repos.tgBindings.list()).toEqual([]);
  });
});

describe("SqliteSettingsRepo", () => {
  it("returns the defaults when nothing is stored", async () => {
    const settings = await store.domain.repos.settings.getAll();

    expect(settings).toEqual({
      reminder_time: "19:00",
      digest_time: "21:00",
      default_due: { offset_days: 1, time: "20:00" },
      paused_until: null,
    });
    expect(await store.domain.repos.settings.get("reminder_time")).toBe("19:00");
  });

  it("persists a value and returns the effective settings", async () => {
    const repos = store.domain.repos;

    const after = await repos.settings.set("reminder_time", "18:30");

    expect(after.reminder_time).toBe("18:30");
    expect(after.digest_time).toBe("21:00");
    expect(await repos.settings.get("reminder_time")).toBe("18:30");
  });

  it("updates several keys at once, including paused_until back to null", async () => {
    const repos = store.domain.repos;

    await repos.settings.update({ reminder_time: "08:00", digest_time: "22:00", paused_until: "2026-01-09" });
    const resumed = await repos.settings.update({ paused_until: null, default_due: { offset_days: 0, time: "12:00" } });

    expect(resumed.reminder_time).toBe("08:00");
    expect(resumed.digest_time).toBe("22:00");
    expect(resumed.paused_until).toBeNull();
    expect(resumed.default_due).toEqual({ offset_days: 0, time: "12:00" });
  });

  it("validates values and refuses garbage", async () => {
    const repos = store.domain.repos;

    await expect(repos.settings.set("reminder_time", "25:00" as never)).rejects.toThrow(/Invalid value/);
    await repos.settings.set("reminder_time", "18:30");
    expect((await repos.settings.getAll()).reminder_time).toBe("18:30");
  });

  it("survives a corrupt row: the default wins and the row is dropped", async () => {
    await store.db.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, "reminder_time", "{not json");

    expect((await store.domain.repos.settings.getAll()).reminder_time).toBe("19:00");
    const row = await store.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM settings`);
    expect(row?.count).toBe(0);
  });

  it("ignores an unknown key from the outside world", async () => {
    await store.db.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, "nonsense", JSON.stringify("x"));

    expect(await store.domain.repos.settings.getAll()).toEqual({
      reminder_time: "19:00",
      digest_time: "21:00",
      default_due: { offset_days: 1, time: "20:00" },
      paused_until: null,
    });
  });
});
