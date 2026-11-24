/**
 * D2: the facade. `openDomain` builds every repository over the connection it is handed, migrations are
 * explicit, and the domain tables coexist with a `pi_*` durable schema in the same file (R1 K2).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Repos } from "../domain/repo.js";
import { createSqliteStores } from "./sql/index.js";
import { DOMAIN_TABLES } from "./schema.js";
import { PNG_BYTES, openTestDomain, type TestDomain } from "./testkit.js";

let current: TestDomain | undefined;

afterEach(async () => {
  if (current !== undefined) {
    await current.close();
    current.remove();
    current = undefined;
  }
});

describe("openDomain", () => {
  it("does not migrate on construction, only when asked", async () => {
    current = await openTestDomain({ skipMigrate: true });

    expect(await current.domain.version()).toBe(0);
    await expect(current.domain.repos.assignments.list()).rejects.toThrow(/no such table/);

    const result = await current.domain.migrate();
    expect(result.version).toBe(1);
    expect(await current.domain.repos.assignments.list()).toEqual([]);
  });

  it("serves every repository of the T1 contract from one connection", async () => {
    current = await openTestDomain();
    // Structural check: the concrete stores satisfy `Repos` without casts.
    const repos: Repos = current.domain.repos;

    const user = await repos.users.create({ openwebui_user_id: "ow-1", role: "parent", name: "Мама" });
    await repos.tgBindings.upsert({ user_id: user.id, chat_id: "42" });
    await repos.settings.set("digest_time", "20:15");
    const assignment = await repos.assignments.create({
      subject: "Математика",
      due_at: "2026-11-25T17:00:00.000Z",
      source: "manual",
      items: [{ label: "№ 12" }],
    });
    const checkIn = await repos.checkIns.create({ assignment_id: assignment.id, child_user_id: "child-1" });
    const photo = await current.domain.photoFiles.save({ kind: "checkin", bytes: PNG_BYTES });
    await repos.photos.attachToCheckIn(checkIn.id, photo.id);
    const items = await repos.assignments.listItems(assignment.id);
    const itemId = items[0]?.id;
    if (itemId === undefined) throw new Error("no items");
    await repos.verifications.createDraft({
      checkin_id: checkIn.id,
      summary: "ок",
      model: "m",
      findings: [{ item_id: itemId, verdict: "ok" }],
    });

    expect((await repos.photos.listByCheckIn(checkIn.id)).map((p) => p.id)).toEqual([photo.id]);
    expect((await repos.verifications.listByAssignment(assignment.id)).map((v) => v.status)).toEqual(["draft"]);
    expect((await repos.settings.getAll()).digest_time).toBe("20:15");
    expect(await repos.tgBindings.getByUserId(user.id)).not.toBeNull();
  });

  it("leaves a durable pi_* schema untouched", async () => {
    current = await openTestDomain({ skipMigrate: true });
    // Stand-in for what `SqliteStorage.open(db, { prefix: "pi_" })` creates (R1 K2).
    await current.db.exec(`
      CREATE TABLE pi_documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX pi_documents_kind ON pi_documents (kind);
      INSERT INTO pi_documents (id, kind, body) VALUES ('1', 'pi.session', '{"kept":true}');
    `);

    await current.domain.migrate();

    const kinds = await current.db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%' ORDER BY name`,
    );
    expect(kinds.map((row) => row.name)).toEqual(["pi_documents"]);
    expect(await current.db.get<{ body: string }>(`SELECT body FROM pi_documents WHERE id = '1'`)).toEqual({
      body: '{"kept":true}',
    });

    const all = await current.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
    const names = all.map((row) => row.name);
    for (const table of DOMAIN_TABLES) expect(names).toContain(table);
    expect(names.filter((name) => name.startsWith("pi_"))).toEqual(["pi_documents"]);
  });

  it("survives a second open over the same file (repos, not state, are rebuilt)", async () => {
    current = await openTestDomain();
    const assignment = await current.domain.repos.assignments.create({
      subject: "История",
      due_at: "2026-11-26T17:00:00.000Z",
      source: "journal",
    });

    const other = createSqliteStores(current.db, { now: () => current?.clock.current ?? new Date() });

    expect((await other.assignments.get(assignment.id))?.subject).toBe("История");
    expect(other).not.toBe(current.domain.repos);
  });
});
