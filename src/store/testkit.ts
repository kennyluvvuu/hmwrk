/**
 * Test helpers for `src/store/*.test.ts` (not a test file itself: vitest only picks `*.test.ts`).
 *
 * The store tests run against a **real SQLite file** in a scratch directory under the session's `$TMPDIR`
 * (never `:memory:`: migration, `rowid` tie-breaks and WAL behave differently in an in-memory database, and the
 * production path is a file). The harness is not opened — the D2 tests only need the same adapter
 * (`openNodeSqliteDatabase`) the facade uses, which is what `Core.db` is.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase, type NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { Id } from "../domain/types.js";
import { openDomain, type Domain } from "./index.js";

/** A domain over a migrated temp SQLite file. */
export interface TestDomain {
  readonly db: NodeSqliteDatabase;
  readonly domain: Domain;
  /** `DATA_DIR` of this file; photos land in `<dataDir>/photos/`. */
  readonly dataDir: string;
  /** Path of the SQLite file. */
  readonly dbPath: string;
  /** Mutable clock handed to the repositories: set `.current` to move time. */
  readonly clock: { current: Date };
  /** Close the connection (call before `remove()`). */
  close(): Promise<void>;
  /** Delete the whole scratch directory. */
  remove(): void;
}

export interface TestDomainOptions {
  /** Initial instant of the frozen clock; default `2026-11-24T16:00:00.000Z`. */
  readonly now?: Date;
  /** Deterministic id factory; default: `id-1`, `id-2`, … per store. */
  readonly newId?: () => Id;
  /** Skip the migration (tests that assert the un-migrated state). */
  readonly skipMigrate?: boolean;
}

/** `id-1`, `id-2`, … — readable assertions and a stable tie-break order. */
export function sequentialIds(prefix = "id"): () => Id {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

/** A domain over a fresh temp file, migrated unless `skipMigrate`. */
export async function openTestDomain(options: TestDomainOptions = {}): Promise<TestDomain> {
  const dir = mkdtempSync(join(tmpdir(), "hmwrk-store-"));
  const dbPath = join(dir, "hmwrk.sqlite");
  const db = await openNodeSqliteDatabase(dbPath);
  const clock = { current: options.now ?? new Date("2026-11-24T16:00:00.000Z") };
  const domain = openDomain({
    db,
    dataDir: dir,
    now: () => clock.current,
    newId: options.newId ?? sequentialIds(),
  });
  if (options.skipMigrate !== true) await domain.migrate();

  return {
    db,
    domain,
    dataDir: dir,
    dbPath,
    clock,
    async close() {
      await db.close();
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Advance the frozen clock by `ms`. */
export function advance(clock: { current: Date }, ms: number): void {
  clock.current = new Date(clock.current.getTime() + ms);
}

/** One hour in ms. */
export const HOUR_MS = 60 * 60 * 1000;

/** A minimal but signature-valid 1×1 PNG (magic bytes matter, pixels do not). */
export const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  ),
);

/** A signature-valid JPEG: `FF D8 FF E0 … FF D9` (no real image data needed for the store). */
export const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
  0x00, 0x00, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9,
]);

/** A signature-valid WebP: `RIFF <size> WEBP VP8 …`. */
export const WEBP_BYTES = new Uint8Array([
  ...Buffer.from("RIFF", "latin1"),
  0x1a, 0x00, 0x00, 0x00,
  ...Buffer.from("WEBPVP8 ", "latin1"),
  0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** Bytes that pass no image check (`%PDF-…`). */
export const NOT_AN_IMAGE = new Uint8Array(Buffer.from("%PDF-1.7 not an image", "latin1"));
