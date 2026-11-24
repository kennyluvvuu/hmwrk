/**
 * `PhotosRepo` over SQLite (SPEC §5.2 `photos`, `checkin_photos`).
 *
 * The bytes live on disk (`src/store/photo-files.ts`); these rows are metadata only, exactly as the spec
 * asks. `attachToCheckIn` needs both rows to exist (the fakes throw `NotFoundError` too), re-attaching is a
 * no-op, and `detachFromCheckIn` keeps the photo row.
 *
 * {@link PhotoStore.remove} is a D2 extension, **not** part of the T1 `PhotosRepo`: the contracts have no
 * delete path, but `PhotoFiles` must be able to drop a file together with its row. Consumers that only know
 * `Repos` never see it.
 */

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { NotFoundError } from "../../domain/errors.js";
import type { NewPhotoInput, PhotosRepo } from "../../domain/repo.js";
import type { Id, Photo, PhotoKind } from "../../domain/types.js";
import type { SqliteContext } from "./context.js";

const PHOTO_COLUMNS = "id, kind, path, mime, created_at";

interface PhotoRow {
  id: string;
  kind: string;
  path: string;
  mime: string;
  created_at: string;
}

function toPhoto(row: PhotoRow): Photo {
  return {
    id: row.id,
    kind: row.kind as PhotoKind,
    path: row.path,
    mime: row.mime,
    created_at: row.created_at,
  };
}

/** `PhotosRepo` plus the two hooks the file-backed store needs. */
export interface PhotoStore extends PhotosRepo {
  /**
   * Create the row under an id chosen by the caller. `PhotoFiles` writes `<id>.<ext>` on disk, so the file
   * name and the row id must be the same id.
   */
  createWithId(id: Id, input: NewPhotoInput): Promise<Photo>;

  /** Remove the photo row and every `checkin_photos` link to it. Returns whether a row existed. */
  remove(id: Id): Promise<boolean>;
}

export class SqlitePhotosRepo implements PhotoStore {
  constructor(private readonly ctx: SqliteContext) {}

  private get db() {
    return this.ctx.db;
  }

  private async require(executor: SqliteExecutor, id: Id, entity = "Photo"): Promise<Photo> {
    const row = await executor.get<PhotoRow>(
      `SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = ?`,
      id,
    );
    if (row === undefined) throw new NotFoundError(`${entity} ${id} not found`);
    return toPhoto(row);
  }

  async create(input: NewPhotoInput): Promise<Photo> {
    return this.createWithId(this.ctx.id(), input);
  }

  async createWithId(id: Id, input: NewPhotoInput): Promise<Photo> {
    const photo: Photo = {
      id,
      kind: input.kind,
      path: input.path,
      mime: input.mime,
      created_at: this.ctx.timestamp(),
    };
    await this.db.run(
      `INSERT INTO photos (id, kind, path, mime, created_at) VALUES (?, ?, ?, ?, ?)`,
      photo.id,
      photo.kind,
      photo.path,
      photo.mime,
      photo.created_at,
    );
    return photo;
  }

  async get(id: Id): Promise<Photo | null> {
    const row = await this.db.get<PhotoRow>(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = ?`, id);
    return row === undefined ? null : toPhoto(row);
  }

  async listByCheckIn(checkinId: Id): Promise<Photo[]> {
    const rows = await this.db.all<PhotoRow>(
      `SELECT p.id, p.kind, p.path, p.mime, p.created_at
       FROM checkin_photos cp
       JOIN photos p ON p.id = cp.photo_id
       WHERE cp.checkin_id = ?
       ORDER BY p.created_at ASC, p.rowid ASC`,
      checkinId,
    );
    return rows.map(toPhoto);
  }

  async listByKind(kind: PhotoKind): Promise<Photo[]> {
    const rows = await this.db.all<PhotoRow>(
      `SELECT ${PHOTO_COLUMNS} FROM photos WHERE kind = ? ORDER BY created_at ASC, rowid ASC`,
      kind,
    );
    return rows.map(toPhoto);
  }

  async attachToCheckIn(checkinId: Id, photoId: Id): Promise<void> {
    const checkIn = await this.db.get<{ id: string }>(
      `SELECT id FROM checkins WHERE id = ?`,
      checkinId,
    );
    if (checkIn === undefined) throw new NotFoundError(`Check-in ${checkinId} not found`);
    await this.require(this.db, photoId);
    await this.db.run(
      `INSERT OR IGNORE INTO checkin_photos (checkin_id, photo_id, created_at) VALUES (?, ?, ?)`,
      checkinId,
      photoId,
      this.ctx.timestamp(),
    );
  }

  async detachFromCheckIn(checkinId: Id, photoId: Id): Promise<void> {
    await this.db.run(
      `DELETE FROM checkin_photos WHERE checkin_id = ? AND photo_id = ?`,
      checkinId,
      photoId,
    );
  }

  async listCheckInIds(photoId: Id): Promise<Id[]> {
    const rows = await this.db.all<{ checkin_id: string }>(
      `SELECT checkin_id FROM checkin_photos WHERE photo_id = ? ORDER BY rowid ASC`,
      photoId,
    );
    return rows.map((row) => row.checkin_id);
  }

  async remove(id: Id): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.run(`DELETE FROM checkin_photos WHERE photo_id = ?`, id);
      const removed = await tx.runCounted(`DELETE FROM photos WHERE id = ?`, id);
      return removed > 0;
    });
  }
}
