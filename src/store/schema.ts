/**
 * DDL of the domain tables (SPEC §5.2 + the fields approved in the orchestrator journal, ruling of
 * 30.11 W1).
 *
 * The tables live in the **same SQLite file** as pi-durable (R1 K2: one connection, one file). pi-durable
 * owns every table and index whose name starts with `pi_` (`PI_SCHEMA_PREFIX`, applied by
 * `SqliteStorage.open`), so the domain tables below are deliberately unprefixed:
 *
 * ```text
 *   pi_conversations, pi_entries, …   ← durable  (prefix "pi_")
 *   assignments, checkins, …          ← domain   (this module)
 * ```
 *
 * {@link assertDomainTableNames} enforces the non-overlap; the migrator calls it before applying anything.
 *
 * Columns beyond SPEC §5.2 are the ones the journal accepted, plus one storage-level helper:
 *
 * | table | column | why |
 * |---|---|---|
 * | `assignments` | `note`, `updated_at` | free-form note; «touched on every status change/item addition» |
 * | `assignments` | `subject_key` | `AssignmentFilter.subject` is case-insensitive on Unicode («Математика»); SQLite's `LOWER()` is ASCII-only, so the key is normalised in JS on write and the filter compares keys |
 * | `assignment_items` | `position`, `created_at` | stable display order inside one assignment |
 * | `checkins` | `comment`, `updated_at` | child's message; verdict recompute after photos were appended |
 * | `photos` | `kind` | `checkin` (notebook photo) vs `screenshot` (intake, SPEC §5.3) |
 * | `verifications` | `decided_by_user_id` | which parent decided the draft |
 * | `users`, `tg_bindings`, `settings` | `created_at` | ordering and audit |
 *
 * Two deliberate storage decisions:
 * - **Instants are stored as TEXT** in the canonical `IsoDateTime` shape (UTC, `toISOString()`), which makes
 *   lexicographic `ORDER BY`/`<`/`>=` comparisons chronological. Repositories normalise every instant on
 *   write, so an input in offset form (`+03:00`) is stored in UTC.
 * - **No `FOREIGN KEY` clauses.** The T1 contracts have no delete path for assignments, check-ins or
 *   verifications, and ids that reach the store may come from a model (verify findings name an
 *   `item_id`). The in-memory fakes accept exactly that, so the SQLite store must not be stricter or
 *   tests written against fakes would fail on the real thing. Referential work that *is* needed (the one
 *   delete path, `PhotoFiles.remove`) is explicit in `./photo-files.ts`.
 */

import { PI_SCHEMA_PREFIX } from "../contracts/harness.js";

/** Domain tables, in dependency order (users first, links last). Used by tests and the overlap guard. */
export const DOMAIN_TABLES = [
  "users",
  "assignments",
  "assignment_items",
  "checkins",
  "photos",
  "checkin_photos",
  "verifications",
  "verification_findings",
  "tg_bindings",
  "settings",
] as const;

/** Name of one domain table. */
export type DomainTable = (typeof DOMAIN_TABLES)[number];

/** Column values enumerated by `CHECK` constraints (mirrors `src/domain/types.ts` constants). */
const ROLE_VALUES = "'parent', 'child'";
const ASSIGNMENT_STATUS_VALUES = "'active', 'in_review', 'done'";
const ASSIGNMENT_SOURCE_VALUES = "'screenshot', 'manual', 'journal'";
const PHOTO_KIND_VALUES = "'checkin', 'screenshot'";
const VERIFICATION_STATUS_VALUES = "'draft', 'approved', 'dismissed'";
const FINDING_VERDICT_VALUES = "'ok', 'wrong', 'missing', 'unclear'";

/**
 * v1 schema: every domain table, index and check constraint in one batch of idempotent statements, so
 * re-running it after a partial failure is harmless. The migrator still wraps it in a transaction.
 */
export const DOMAIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  openwebui_user_id TEXT NOT NULL UNIQUE,
  role              TEXT NOT NULL CHECK (role IN (${ROLE_VALUES})),
  name              TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  due_at      TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN (${ASSIGNMENT_SOURCE_VALUES})),
  status      TEXT NOT NULL CHECK (status IN (${ASSIGNMENT_STATUS_VALUES})),
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assignments_due ON assignments (due_at, created_at);
CREATE INDEX IF NOT EXISTS assignments_status_due ON assignments (status, due_at);
CREATE INDEX IF NOT EXISTS assignments_subject_key ON assignments (subject_key);

CREATE TABLE IF NOT EXISTS assignment_items (
  id            TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  label         TEXT NOT NULL,
  note          TEXT,
  position      INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assignment_items_assignment ON assignment_items (assignment_id, position, created_at);

CREATE TABLE IF NOT EXISTS checkins (
  id            TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  child_user_id TEXT NOT NULL,
  comment       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkins_assignment ON checkins (assignment_id, created_at);
CREATE INDEX IF NOT EXISTS checkins_child ON checkins (child_user_id, created_at);
CREATE INDEX IF NOT EXISTS checkins_created ON checkins (created_at);

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN (${PHOTO_KIND_VALUES})),
  path       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_kind ON photos (kind, created_at);

CREATE TABLE IF NOT EXISTS checkin_photos (
  checkin_id TEXT NOT NULL,
  photo_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (checkin_id, photo_id)
);
CREATE INDEX IF NOT EXISTS checkin_photos_photo ON checkin_photos (photo_id);

CREATE TABLE IF NOT EXISTS verifications (
  id                 TEXT PRIMARY KEY,
  checkin_id         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN (${VERIFICATION_STATUS_VALUES})),
  summary            TEXT NOT NULL,
  model              TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  decided_at         TEXT,
  decided_by_user_id TEXT
);
CREATE INDEX IF NOT EXISTS verifications_checkin ON verifications (checkin_id, created_at);
CREATE INDEX IF NOT EXISTS verifications_status ON verifications (status, created_at);

CREATE TABLE IF NOT EXISTS verification_findings (
  verification_id TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  verdict         TEXT NOT NULL CHECK (verdict IN (${FINDING_VERDICT_VALUES})),
  comment         TEXT,
  PRIMARY KEY (verification_id, item_id)
);
CREATE INDEX IF NOT EXISTS verification_findings_item ON verification_findings (item_id);

CREATE TABLE IF NOT EXISTS tg_bindings (
  user_id    TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Guard against a domain table colliding with the durable schema (which owns `pi_*`). Called by the
 * migrator; also a cheap unit test.
 */
export function assertDomainTableNames(
  tables: readonly string[] = DOMAIN_TABLES,
  durablePrefix: string = PI_SCHEMA_PREFIX,
): void {
  for (const table of tables) {
    if (table.startsWith(durablePrefix)) {
      throw new Error(
        `Domain table ${JSON.stringify(table)} collides with the durable prefix ${JSON.stringify(durablePrefix)}; durable tables and indexes are owned by pi-durable`,
      );
    }
    if (!/^[a-z][a-z0-9_]*$/.test(table)) {
      throw new Error(`Domain table name ${JSON.stringify(table)} is not a plain lowercase SQLite identifier`);
    }
  }
  const seen = new Set<string>();
  for (const table of tables) {
    const key = table.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate domain table ${JSON.stringify(table)}`);
    seen.add(key);
  }
}
