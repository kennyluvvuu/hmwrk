/**
 * Minimal forward-only migrator for the domain tables (D2).
 *
 * pi-durable migrates its own `pi_*` schema inside `SqliteStorage.open` (R1 K2); this is the host-side
 * counterpart, deliberately without a framework:
 *
 * - `schema_version` records one row per applied migration (`version` is the primary key);
 * - {@link DOMAIN_MIGRATIONS} is a chained list, strict ascending versions, v1 = the whole v1 schema;
 * - {@link migrate} applies only the versions above the current one, **in one transaction**, so a failure
 *   leaves the schema exactly as it was and the next boot retries;
 * - a second run is a no-op: no transaction is opened and nothing is written.
 *
 * Adding a migration means appending `{ version: 2, name, sql }` — never editing v1's SQL.
 */

import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";
import { toIso } from "../domain/dates.js";
import { DOMAIN_SCHEMA_SQL, assertDomainTableNames } from "./schema.js";

/** Bookkeeping table of the migrator itself (created before anything else, not part of {@link DOMAIN_TABLES}). */
export const SCHEMA_VERSION_TABLE = "schema_version";

/** DDL of the bookkeeping table. Idempotent, so it runs on every boot. */
export const SCHEMA_VERSION_SQL = `
CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSION_TABLE} (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

/** One forward migration: a version, a name for the log and a batch of idempotent statements. */
export interface DomainMigration {
  readonly version: number;
  readonly name: string;
  /** SQL text; `SqliteExecutor.exec` accepts several statements in one string. */
  readonly sql: string;
}

/** The chain. v1 creates every domain table of SPEC §5.2 (see `./schema.ts`). */
export const DOMAIN_MIGRATIONS: readonly DomainMigration[] = [
  { version: 1, name: "initial-domain-schema", sql: DOMAIN_SCHEMA_SQL },
];

/** Outcome of one {@link migrate} call. */
export interface MigrationResult {
  /** Schema version after the call. */
  readonly version: number;
  /** Migrations applied by this call, ascending; empty on a no-op run. */
  readonly applied: readonly DomainMigration[];
}

/** Highest applied version (`0` on a fresh file, before the bookkeeping table exists). */
export async function schemaVersion(executor: SqliteExecutor): Promise<number> {
  const table = await executor.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    SCHEMA_VERSION_TABLE,
  );
  if (table === undefined) return 0;
  const row = await executor.get<{ version: number | null }>(
    `SELECT MAX(version) AS version FROM ${SCHEMA_VERSION_TABLE}`,
  );
  const version = row?.version;
  return typeof version === "number" ? version : 0;
}

function assertChain(migrations: readonly DomainMigration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new Error(
        `Migration versions must be strictly ascending integers, got ${migration.version} after ${previous}`,
      );
    }
    previous = migration.version;
  }
}

export interface MigrateOptions {
  /** Clock for `schema_version.applied_at`; defaults to the real one. */
  readonly now?: () => Date;
}

/**
 * Bring `db` to the chain's latest version. Idempotent; never touches `pi_*` tables.
 *
 * Returns the applied migrations so a boot log can say «schema v1 applied» and a second run can say
 * «already at v1, nothing to do».
 */
export async function migrate(
  db: SqliteDatabase,
  migrations: readonly DomainMigration[] = DOMAIN_MIGRATIONS,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  assertChain(migrations);
  assertDomainTableNames();

  await db.exec(SCHEMA_VERSION_SQL);
  const current = await schemaVersion(db);
  const pending = migrations.filter((migration) => migration.version > current);
  if (pending.length === 0) return { version: current, applied: [] };

  const clock = options.now ?? (() => new Date());
  const applied = await db.transaction(async (tx) => {
    for (const migration of pending) {
      await tx.exec(migration.sql);
      await tx.run(
        `INSERT INTO ${SCHEMA_VERSION_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
        migration.version,
        migration.name,
        toIso(clock()),
      );
    }
    return pending;
  });

  const version = applied[applied.length - 1]?.version ?? current;
  return { version, applied };
}
