/**
 * Photo bytes on disk + the `photos` metadata row that points at them (SPEC §5.2: «Фото — файлы в
 * `data/photos/`, в базе только пути»).
 *
 * Layout: `DATA_DIR/photos/<id>.<ext>` — the flat root the D2 brief asks for. `Photo.path` stays relative to
 * that root (`<id>.<ext>`), so moving `DATA_DIR` or the whole `photos/` tree never invalidates the rows. The
 * intake screenshots of SPEC §5.3 share this root and are told apart by `photos.kind` (`screenshot`), not by
 * a subdirectory, so `PhotoFiles` can serve both kinds with one path rule.
 *
 * Safety rules, all of them cheap and all of them load-bearing:
 * - **format by magic bytes**, never by the caller's claim: jpeg / png / webp only. A file that is not one of
 *   the three is rejected before anything is written (an image the vision model will read must be a real
 *   image; «application/octet-stream» reaching Groq is a wasted request);
 * - **size limit** {@link PHOTO_MAX_BYTES} (8 MiB), checked before writing. pi-ai resizes images to
 *   `inputLimits.images.resize` (R1 K10) downstream; the store keeps the original but refuses absurd input;
 * - **path containment**: `read()` resolves the stored relative path against the root and refuses to escape it,
 *   so a corrupt `photos.path` cannot make the store read `/etc/passwd`.
 *
 * The write is «file first, row second», and a failing row insert removes the file again: no orphan bytes and
 * no row pointing at nothing. `remove()` is the reverse (row + links first, then the file).
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { InvalidValueError, NotFoundError } from "../domain/errors.js";
import { newId as defaultNewId } from "../domain/types.js";
import type { Id, Photo, PhotoKind } from "../domain/types.js";
import type { PhotoStore } from "./sql/photos.js";

/** Subdirectory of `DATA_DIR` that holds the bytes (SPEC §5.2). */
export const PHOTO_DIR_NAME = "photos";

/** Refuse files above this size; pi-ai will shrink them for the model anyway (R1 K10). */
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

/** Formats the store accepts, with their on-disk extension and canonical MIME type. */
export const PHOTO_FORMATS = {
  jpeg: { ext: "jpg", mime: "image/jpeg" },
  png: { ext: "png", mime: "image/png" },
  webp: { ext: "webp", mime: "image/webp" },
} as const;

/** One of {@link PHOTO_FORMATS}. */
export type PhotoFormat = keyof typeof PHOTO_FORMATS;

const MIME_TO_FORMAT: Readonly<Record<string, PhotoFormat>> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let index = start; index < start + length; index += 1) {
    out += String.fromCharCode(bytes[index] ?? 0);
  }
  return out;
}

/**
 * Detect the image format from the leading bytes (`null` when it is none of jpeg/png/webp).
 *
 * jpeg: `FF D8 FF`; png: the 8-byte signature; webp: `RIFF` + size + `WEBP` (RIFF container).
 */
export function detectPhotoFormat(bytes: Uint8Array): PhotoFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((byte, index) => bytes[index] === byte)) return "png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  return null;
}

/** Input of {@link PhotoFiles.save}. */
export interface SavePhotoInput {
  /** `checkin` (notebook photo) or `screenshot` (intake, SPEC §5.3). */
  readonly kind: PhotoKind;
  readonly bytes: Uint8Array;
  /** Caller's claim; when given it must match the detected format (`image/jpeg`/`png`/`webp`). */
  readonly mime?: string;
}

/** Dependencies: the metadata store plus the root directory. */
export interface PhotoFilesOptions {
  /** `DATA_DIR` — the store appends `photos/`. */
  readonly dataDir: string;
  readonly photos: PhotoStore;
  /** Override of the size limit (tests, future config). */
  readonly maxBytes?: number;
  /** Id factory for the file name (the row gets the same id); defaults to uuid v4. */
  readonly newId?: () => Id;
}

/**
 * File store for photos. Construction is free of I/O; the first `save()` creates `data/photos/`.
 */
export class PhotoFiles {
  /** Absolute root of the photo files. */
  private readonly root: string;
  private readonly photos: PhotoStore;
  private readonly maxBytes: number;
  private readonly ids: () => Id;

  constructor(options: PhotoFilesOptions) {
    this.root = resolve(options.dataDir, PHOTO_DIR_NAME);
    this.photos = options.photos;
    this.maxBytes = options.maxBytes ?? PHOTO_MAX_BYTES;
    this.ids = options.newId ?? defaultNewId;
  }

  /** Absolute path of the photo root (`<DATA_DIR>/photos`). */
  get photoRoot(): string {
    return this.root;
  }

  /** Absolute path of a stored photo; throws when the row's path would escape the root. */
  absolutePath(photo: Pick<Photo, "path">): string {
    return this.contained(photo.path);
  }

  /**
   * Write `bytes` to `<root>/<id>.<ext>` and insert the `photos` row.
   *
   * Rejects (without writing anything) when the format is unsupported, the declared mime disagrees with the
   * bytes, or the file is larger than the limit.
   */
  async save(input: SavePhotoInput): Promise<Photo> {
    if (input.bytes.byteLength === 0) {
      throw new InvalidValueError("invalid_argument", "Photo payload is empty");
    }
    const format = detectPhotoFormat(input.bytes);
    if (format === null) {
      throw new InvalidValueError(
        "invalid_argument",
        "Unsupported photo format: only JPEG, PNG and WebP are accepted (checked by magic bytes)",
      );
    }
    const expected = PHOTO_FORMATS[format];
    if (input.mime !== undefined && input.mime.toLowerCase() !== expected.mime) {
      const declared = MIME_TO_FORMAT[input.mime.toLowerCase()];
      throw new InvalidValueError(
        "invalid_argument",
        `Photo mime ${JSON.stringify(input.mime)} does not match its content (${expected.mime}${
          declared === undefined ? "" : `, declared format ${declared}`
        })`,
      );
    }
    if (input.bytes.byteLength > this.maxBytes) {
      throw new InvalidValueError(
        "invalid_argument",
        `Photo is ${input.bytes.byteLength} bytes, the limit is ${this.maxBytes} bytes`,
      );
    }

    await mkdir(this.root, { recursive: true });
    // One id for both the file name and the row: `photos.path` is `<id>.<ext>` (see the module comment).
    const id = this.ids();
    const path = `${id}.${expected.ext}`;
    const target = this.contained(path);
    // `wx` fails if the name is taken, so a collision can never overwrite another child's photo.
    await writeFile(target, input.bytes, { flag: "wx" });
    try {
      return await this.photos.createWithId(id, { kind: input.kind, path, mime: expected.mime });
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }

  /** Bytes of a stored photo (by row or id). `NotFoundError` for an unknown row or a missing file. */
  async read(photoOrId: Photo | Id): Promise<Uint8Array> {
    const photo = typeof photoOrId === "string" ? await this.require(photoOrId) : photoOrId;
    const target = this.contained(photo.path);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NotFoundError(`Photo file ${photo.path} is missing on disk`);
      }
      throw error;
    }
  }

  /** Whether the bytes of `photo` are on disk. */
  async exists(photo: Photo): Promise<boolean> {
    try {
      const stats = await stat(this.contained(photo.path));
      return stats.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Delete a photo: the row, its `checkin_photos` links and then the file. A missing file is not an error
   * (a half-cleaned directory must not block the row removal); a missing row returns `false`.
   */
  async remove(photoOrId: Photo | Id): Promise<boolean> {
    const photo = typeof photoOrId === "string" ? await this.photos.get(photoOrId) : photoOrId;
    if (photo === null) return false;
    const removed = await this.photos.remove(photo.id);
    if (!removed) return false;
    await rm(this.contained(photo.path), { force: true });
    return true;
  }

  private async require(id: Id): Promise<Photo> {
    const photo = await this.photos.get(id);
    if (photo === null) throw new NotFoundError(`Photo ${id} not found`);
    return photo;
  }

  /** Resolve a stored relative path and refuse anything outside the photo root. */
  private contained(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new InvalidValueError(
        "invalid_argument",
        `Photo path ${JSON.stringify(relativePath)} must be relative to the photo root`,
      );
    }
    const target = resolve(this.root, relativePath);
    const rel = relative(this.root, target);
    if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`) || isAbsolute(rel)) {
      throw new InvalidValueError(
        "invalid_argument",
        `Photo path ${JSON.stringify(relativePath)} escapes the photo root`,
      );
    }
    return target;
  }
}

/** Convenience constructor mirroring `createSqliteStores`. */
export function createPhotoFiles(options: PhotoFilesOptions): PhotoFiles {
  return new PhotoFiles(options);
}
