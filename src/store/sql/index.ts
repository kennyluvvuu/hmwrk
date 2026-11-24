/**
 * All repository implementations over one `SqliteDatabase` — the same object `Core.db` holds (K2: one file,
 * one connection, no second storage).
 *
 * ```ts
 * const repos = createSqliteStores(core.db);
 * const assignment = await repos.assignments.create({ subject: "Математика", due_at, source: "manual" });
 * ```
 *
 * The returned object **is** a `Repos` (the T1 contract), so tools, durable tasks and server routes take it
 * without knowing SQLite exists. `photos` is additionally a {@link PhotoStore} (adds `remove()`), which only
 * `PhotoFiles` uses.
 */

import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import type { Repos } from "../../domain/repo.js";
import { SqliteAssignmentsRepo } from "./assignments.js";
import { SqliteCheckInsRepo } from "./checkins.js";
import { SqliteContext, type SqliteStoreOptions } from "./context.js";
import { SqlitePhotosRepo, type PhotoStore } from "./photos.js";
import { SqliteSettingsRepo } from "./settings.js";
import { SqliteTgBindingsRepo } from "./tg-bindings.js";
import { SqliteUsersRepo } from "./users.js";
import { SqliteVerificationsRepo } from "./verifications.js";

export { SqliteAssignmentsRepo } from "./assignments.js";
export { SqliteCheckInsRepo } from "./checkins.js";
export { SqliteContext, type SqliteStoreOptions } from "./context.js";
export { SqlitePhotosRepo, type PhotoStore } from "./photos.js";
export { SqliteSettingsRepo } from "./settings.js";
export { SqliteTgBindingsRepo } from "./tg-bindings.js";
export { SqliteUsersRepo } from "./users.js";
export { SqliteVerificationsRepo } from "./verifications.js";

/** Every repository of the domain, SQLite-backed. */
export interface SqliteStores extends Repos {
  readonly users: SqliteUsersRepo;
  readonly assignments: SqliteAssignmentsRepo;
  readonly checkIns: SqliteCheckInsRepo;
  readonly photos: SqlitePhotosRepo;
  readonly verifications: SqliteVerificationsRepo;
  readonly tgBindings: SqliteTgBindingsRepo;
  readonly settings: SqliteSettingsRepo;
}

/** The `photos` member seen through its extended (delete-capable) shape. */
export type SqlitePhotoStore = PhotoStore;

/**
 * Build all repositories over `db`. Migrations are **not** run here: `openDomain()` in `./index.ts` owns the
 * order «migrate, then serve»; this factory stays free of side effects so tests can build stores over a
 * connection they control.
 */
export function createSqliteStores(db: SqliteDatabase, options: SqliteStoreOptions = {}): SqliteStores {
  const ctx = new SqliteContext(db, options);
  return {
    users: new SqliteUsersRepo(ctx),
    assignments: new SqliteAssignmentsRepo(ctx),
    checkIns: new SqliteCheckInsRepo(ctx),
    photos: new SqlitePhotosRepo(ctx),
    verifications: new SqliteVerificationsRepo(ctx),
    tgBindings: new SqliteTgBindingsRepo(ctx),
    settings: new SqliteSettingsRepo(ctx),
  };
}
