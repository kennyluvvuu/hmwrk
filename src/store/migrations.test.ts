/**
 * D2: the migrator. A second run must be a no-op, the tables must appear once, and the bookkeeping table
 * must not be dragged into the domain namespace.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  DOMAIN_MIGRATIONS,
  SCHEMA_VERSION_TABLE,
  migrate,
  schemaVersion,
  type DomainMigration,
} from "./migrations.js";
import { DOMAIN_TABLES, assertDomainTableNames } from "./schema.js";
import { openTestDomain, type TestDomain } from "./testkit.js";

let current: TestDomain | undefined;

afterEach(async () => {
  if (current !== undefined) {
    await current.close();
    current.remove();
    current = undefined;
  }
});

async function tables(db: TestDomain["db"]): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  );
  return rows.map((row) => row.name);
}

describe("migrate", () => {
  it("creates every domain table and records version 1", async () => {
    current = await openTestDomain({ skipMigrate: true });
    const { db, domain } = current;

    expect(await domain.version()).toBe(0);

    const result = await domain.migrate();

    expect(result.version).toBe(1);
    expect(result.applied.map((migration) => migration.version)).toEqual([1]);

    const created = await tables(db);
    for (const table of DOMAIN_TABLES) expect(created).toContain(table);
    expect(created).toContain(SCHEMA_VERSION_TABLE);
    expect(await domain.version()).toBe(1);
  });

  it("is idempotent: a second run applies nothing and writes no version row", async () => {
    current = await openTestDomain();
    const { db, domain } = current;

    const second = await domain.migrate();

    expect(second.applied).toEqual([]);
    expect(second.version).toBe(1);
    const rows = await db.all<{ version: number }>(`SELECT version FROM ${SCHEMA_VERSION_TABLE}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it("survives a reopen of the same file (the schema is durable, not per-process)", async () => {
    current = await openTestDomain();
    await current.domain.repos.assignments.create({
      subject: "Математика",
      due_at: "2026-11-25T17:00:00.000Z",
      source: "manual",
    });
    await current.close();

    // Reopen without removing the directory: migration must find v1 and keep the data.
    const { openNodeSqliteDatabase } = await import("@earendil-works/chord/sqlite/node");
    const { openDomain } = await import("./index.js");
    const db = await openNodeSqliteDatabase(current.dbPath);
    const domain = openDomain({ db, dataDir: current.dataDir });
    try {
      expect(await schemaVersion(db)).toBe(1);
      expect((await domain.migrate()).applied).toEqual([]);
      expect(await domain.repos.assignments.list()).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it("applies only the pending tail of the chain", async () => {
    current = await openTestDomain({ skipMigrate: true });
    const chain: DomainMigration[] = [
      ...DOMAIN_MIGRATIONS,
      { version: 2, name: "add-nothing", sql: "SELECT 1" },
    ];

    const first = await migrate(current.db, chain);
    const second = await migrate(current.db, chain);

    expect(first.applied.map((migration) => migration.version)).toEqual([1, 2]);
    expect(second.applied).toEqual([]);
    expect(second.version).toBe(2);
  });

  it("rejects a chain whose versions are not strictly ascending", async () => {
    current = await openTestDomain({ skipMigrate: true });
    const broken: DomainMigration[] = [
      { version: 2, name: "second", sql: "SELECT 1" },
      { version: 1, name: "first", sql: "SELECT 1" },
    ];

    await expect(migrate(current.db, broken)).rejects.toThrow(/strictly ascending/);
  });

  it("leaves no half-applied schema when a migration throws", async () => {
    current = await openTestDomain({ skipMigrate: true });
    const failing: DomainMigration[] = [
      ...DOMAIN_MIGRATIONS,
      { version: 2, name: "boom", sql: "INSERT INTO no_such_table (x) VALUES (1)" },
    ];

    await expect(migrate(current.db, failing)).rejects.toThrow(/no_such_table/);
    expect(await schemaVersion(current.db)).toBe(0);
    // v1 ran inside the rolled-back transaction, so not even its tables survive.
    expect(await tables(current.db)).not.toContain("assignments");
  });
});

describe("assertDomainTableNames", () => {
  it("accepts the shipped tables", () => {
    expect(() => assertDomainTableNames()).not.toThrow();
  });

  it("refuses a table in the durable namespace", () => {
    expect(() => assertDomainTableNames(["assignments", "pi_documents"])).toThrow(/durable prefix/);
  });

  it("refuses duplicates and non-identifier names", () => {
    expect(() => assertDomainTableNames(["a", "a"])).toThrow(/Duplicate/);
    expect(() => assertDomainTableNames(["Assignments"])).toThrow(/lowercase SQLite identifier/);
  });
});
