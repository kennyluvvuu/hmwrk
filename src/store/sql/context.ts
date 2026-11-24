/**
 * Shared plumbing of the SQLite repositories: one database handle, one clock, one id factory.
 *
 * The repositories never read the wall clock or call `crypto.randomUUID()` themselves — they ask the
 * context, exactly like the in-memory fakes (`src/domain/fakes.ts`, `MemoryOptions`), so tests freeze
 * timestamps and ids the same way for both implementations.
 */

import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { asDate, toIso } from "../../domain/dates.js";
import { newId as defaultNewId } from "../../domain/types.js";
import type { DateInput, Id, IsoDateTime } from "../../domain/types.js";

/** Options every SQLite repository honours (mirrors `MemoryOptions` of the fakes). */
export interface SqliteStoreOptions {
  /** Clock; defaults to the real one. Repositories derive `created_at`/`updated_at` from it. */
  readonly now?: () => Date;
  /** ID factory; defaults to uuid v4. */
  readonly newId?: () => Id;
}

/** Per-repository state: the connection plus the injected clock and id factory. */
export class SqliteContext {
  readonly db: SqliteDatabase;
  private readonly clock: () => Date;
  private readonly ids: () => Id;

  constructor(db: SqliteDatabase, options: SqliteStoreOptions = {}) {
    this.db = db;
    this.clock = options.now ?? (() => new Date());
    this.ids = options.newId ?? defaultNewId;
  }

  /** Now, as the entity shape wants it. */
  now(): Date {
    return this.clock();
  }

  /** `created_at`/`updated_at` of a row written right now. */
  timestamp(): IsoDateTime {
    return toIso(this.clock());
  }

  /** New entity id. */
  id(): Id {
    return this.ids();
  }

  /** Same clock/ids over a transaction handle (writes inside `db.transaction`). */
  with(executor: SqliteExecutor): SqliteExecutorContext {
    return new SqliteExecutorContext(executor, this);
  }
}

/** Clock/id access bound to a transaction handle, for helpers that write. */
export class SqliteExecutorContext {
  readonly tx: SqliteExecutor;
  private readonly parent: SqliteContext;

  constructor(tx: SqliteExecutor, parent: SqliteContext) {
    this.tx = tx;
    this.parent = parent;
  }

  timestamp(): IsoDateTime {
    return this.parent.timestamp();
  }

  id(): Id {
    return this.parent.id();
  }
}

/**
 * Normalise an instant for storage or comparison.
 *
 * Stored instants are canonical UTC `IsoDateTime` strings, which makes SQLite's text comparison
 * chronological. Inputs in offset form (`2026-11-25T20:00:00+03:00`) are converted; garbage throws
 * `InvalidValueError` from `src/domain/dates.ts` instead of being written as an unorderable string.
 */
export function storedInstant(value: DateInput): IsoDateTime {
  return toIso(asDate(value));
}

/** `AssignmentFilter.subject` key: trimmed and lowercased in JS (SQLite's `LOWER()` is ASCII-only). */
export function subjectKey(subject: string): string {
  return subject.trim().toLowerCase();
}

/** `LIMIT`/`OFFSET` clause for an optional limit (`LIMIT -1` means «no limit» in SQLite). */
export function paginate(limit: number | undefined, offset: number | undefined): { sql: string; params: SqliteValue[] } {
  if (limit === undefined && (offset === undefined || offset === 0)) return { sql: "", params: [] };
  const params: SqliteValue[] = [limit ?? -1];
  if (offset !== undefined && offset > 0) {
    params.push(offset);
    return { sql: " LIMIT ? OFFSET ?", params };
  }
  return { sql: " LIMIT ?", params };
}

/** `?, ?, ?` for an `IN (...)` list; throws on an empty list so callers handle that case themselves. */
export function placeholders(count: number): string {
  if (count <= 0) throw new Error("placeholders() needs at least one value");
  return new Array(count).fill("?").join(", ");
}
