/**
 * The store facade: domain repositories + photo files over the `SqliteDatabase` the durable core already
 * holds (R1 K2 — one file, one connection, no second storage; the tables of both families live side by side,
 * durable ones prefixed `pi_`, ours unprefixed — see `./schema.ts`).
 *
 * ```ts
 * const core = await openHarness(cfg);
 * const domain = openDomain({ db: core.db, dataDir: cfg.dataDir });
 * const { applied } = await domain.migrate();     // idempotent; a no-op on a migrated file
 * const assignments = await domain.repos.assignments.listActive();
 * const photo = await domain.photoFiles.save({ kind: "checkin", bytes });
 * ```
 *
 * `openDomain()` does no I/O: it builds the repositories, the migrator and the photo file store. Boot order is
 * explicit — {@link Domain.migrate} **must** run before the first repository call that touches a table (the
 * migrator is separated on purpose so a caller can decide when the schema changes, and so tests can migrate
 * a connection they own).
 *
 * What this module deliberately does **not** do: open or close the database (the core owns its lifetime),
 * create `DATA_DIR` (the config layer does, see `src/contracts/harness.ts`), or know about pi-durable.
 */

import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import {
  DOMAIN_MIGRATIONS,
  migrate as runMigrations,
  schemaVersion,
  type DomainMigration,
  type MigrationResult,
} from "./migrations.js";
import { createPhotoFiles, PhotoFiles } from "./photo-files.js";
import { createSqliteStores, type SqliteStores, type SqliteStoreOptions } from "./sql/index.js";

export * from "./migrations.js";
export * from "./photo-files.js";
export * from "./schema.js";
export * from "./sql/index.js";

/** Options of {@link openDomain}. */
export interface OpenDomainOptions extends SqliteStoreOptions {
  /** The shared connection (`Core.db`). The store never opens or closes it. */
  readonly db: SqliteDatabase;
  /** `DATA_DIR`; photos go to `<dataDir>/photos/`. */
  readonly dataDir: string;
  /** Size limit of one photo (default {@link PHOTO_MAX_BYTES}). */
  readonly maxPhotoBytes?: number;
  /** Migration chain; defaults to {@link DOMAIN_MIGRATIONS} (append-only). */
  readonly migrations?: readonly DomainMigration[];
}

/** Everything the boot code needs from the domain side. */
export interface Domain {
  /** Repositories, all over the same connection. */
  readonly repos: SqliteStores;
  /** Photo bytes on disk plus the `photos` rows. */
  readonly photoFiles: PhotoFiles;
  /** Apply pending migrations; idempotent. */
  migrate(): Promise<MigrationResult>;
  /** Current schema version (`0` before the first migration). */
  version(): Promise<number>;
}

/** Build the domain stores over an already open connection. Does not migrate. */
export function openDomain(options: OpenDomainOptions): Domain {
  const repos = createSqliteStores(options.db, options);
  const photoFiles = createPhotoFiles({
    dataDir: options.dataDir,
    photos: repos.photos,
    ...(options.maxPhotoBytes === undefined ? {} : { maxBytes: options.maxPhotoBytes }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  });

  return {
    repos,
    photoFiles,
    migrate(): Promise<MigrationResult> {
      return runMigrations(options.db, options.migrations ?? DOMAIN_MIGRATIONS, {
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    },
    version(): Promise<number> {
      return schemaVersion(options.db);
    },
  };
}
