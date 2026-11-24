/**
 * D2: photo bytes on disk (`data/photos/<id>.<ext>`) plus the `photos` row — magic-byte format checks, the size
 * limit, the roundtrip and the «delete the row → delete the file» rule.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDomain } from "./index.js";
import { PHOTO_MAX_BYTES, detectPhotoFormat, type PhotoFiles } from "./photo-files.js";
import {
  JPEG_BYTES,
  NOT_AN_IMAGE,
  PNG_BYTES,
  WEBP_BYTES,
  openTestDomain,
  type TestDomain,
} from "./testkit.js";

let store: TestDomain;
let files: PhotoFiles;

beforeEach(async () => {
  store = await openTestDomain();
  files = store.domain.photoFiles;
});

afterEach(async () => {
  await store.close();
  store.remove();
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("detectPhotoFormat", () => {
  it("recognises jpeg, png and webp by their leading bytes", () => {
    expect(detectPhotoFormat(JPEG_BYTES)).toBe("jpeg");
    expect(detectPhotoFormat(PNG_BYTES)).toBe("png");
    expect(detectPhotoFormat(WEBP_BYTES)).toBe("webp");
    expect(detectPhotoFormat(NOT_AN_IMAGE)).toBeNull();
    expect(detectPhotoFormat(new Uint8Array())).toBeNull();
  });
});

describe("PhotoFiles.save", () => {
  it("writes <id>.<ext> under data/photos and inserts a row that points at it", async () => {
    const photo = await files.save({ kind: "checkin", bytes: PNG_BYTES });

    expect(photo.kind).toBe("checkin");
    expect(photo.mime).toBe("image/png");
    expect(photo.path).toBe(`${photo.id}.png`);
    expect(files.photoRoot).toBe(join(store.dataDir, "photos"));
    expect(await exists(join(store.dataDir, "photos", photo.path))).toBe(true);
    expect(await store.domain.repos.photos.get(photo.id)).toEqual(photo);
    expect(await files.exists(photo)).toBe(true);
  });

  it("picks the extension from the content, not from the caller", async () => {
    const jpeg = await files.save({ kind: "screenshot", bytes: JPEG_BYTES });
    const webp = await files.save({ kind: "checkin", bytes: WEBP_BYTES, mime: "image/webp" });

    expect(jpeg.mime).toBe("image/jpeg");
    expect(jpeg.path.endsWith(".jpg")).toBe(true);
    expect(webp.path.endsWith(".webp")).toBe(true);
    expect(webp.kind).toBe("checkin");
  });

  it("round-trips the bytes", async () => {
    const photo = await files.save({ kind: "checkin", bytes: PNG_BYTES });

    const back = await files.read(photo);
    expect(back).toEqual(PNG_BYTES);
    expect(await files.read(photo.id)).toEqual(PNG_BYTES);
  });

  it("rejects a payload that is not an image, without writing anything", async () => {
    await expect(files.save({ kind: "checkin", bytes: NOT_AN_IMAGE })).rejects.toThrow(/Unsupported photo format/);
    expect(await store.domain.repos.photos.listByKind("checkin")).toEqual([]);
    expect(await exists(files.photoRoot)).toBe(false);
  });

  it("rejects a mime that contradicts the bytes", async () => {
    await expect(files.save({ kind: "checkin", bytes: PNG_BYTES, mime: "image/jpeg" })).rejects.toThrow(
      /does not match its content/,
    );
    expect(await store.domain.repos.photos.listByKind("checkin")).toEqual([]);
  });

  it("rejects an empty payload", async () => {
    await expect(files.save({ kind: "checkin", bytes: new Uint8Array() })).rejects.toThrow(/payload is empty/);
  });

  it("enforces the size limit", async () => {
    const oversized = new Uint8Array(PHOTO_MAX_BYTES + 1);
    oversized.set(PNG_BYTES);

    await expect(files.save({ kind: "checkin", bytes: oversized })).rejects.toThrow(/the limit is/);
    expect(await store.domain.repos.photos.listByKind("checkin")).toEqual([]);
  });

  it("honours a custom limit", async () => {
    const tiny = openDomain({
      db: store.db,
      dataDir: store.dataDir,
      maxPhotoBytes: 8,
    });

    await expect(tiny.photoFiles.save({ kind: "checkin", bytes: PNG_BYTES })).rejects.toThrow(/the limit is 8 bytes/);
  });

  it("removes the file again when the row insert fails", async () => {
    const broken = openDomain({
      db: store.db,
      dataDir: store.dataDir,
      newId: () => "fixed-id",
    });
    // Give the row insert a reason to fail: a photo row with this id already exists.
    await store.domain.repos.photos.createWithId("fixed-id", { kind: "checkin", path: "taken.png", mime: "image/png" });

    await expect(broken.photoFiles.save({ kind: "checkin", bytes: PNG_BYTES })).rejects.toThrow();
    expect(await exists(join(store.dataDir, "photos", "fixed-id.png"))).toBe(false);
  });
});

describe("PhotoFiles.read and remove", () => {
  it("reports a missing file and a missing row", async () => {
    const photo = await files.save({ kind: "checkin", bytes: PNG_BYTES });
    await files.remove(photo.id);

    await expect(files.read(photo.id)).rejects.toThrow(/not found/);
    await expect(files.read(photo)).rejects.toThrow(/is missing on disk/);
  });

  it("remove deletes the row, the links and the file", async () => {
    const repos = store.domain.repos;
    const assignment = await repos.assignments.create({
      subject: "Математика",
      due_at: "2026-11-25T17:00:00.000Z",
      source: "manual",
    });
    const checkIn = await repos.checkIns.create({ assignment_id: assignment.id, child_user_id: "child-1" });
    const photo = await files.save({ kind: "checkin", bytes: PNG_BYTES });
    await repos.photos.attachToCheckIn(checkIn.id, photo.id);

    expect(await files.remove(photo.id)).toBe(true);
    expect(await exists(join(store.dataDir, "photos", photo.path))).toBe(false);
    expect(await repos.photos.get(photo.id)).toBeNull();
    expect(await repos.photos.listByCheckIn(checkIn.id)).toEqual([]);
    expect(await files.remove(photo.id)).toBe(false);
  });

  it("refuses a stored path that escapes the photo root", async () => {
    const evil = await store.domain.repos.photos.create({
      kind: "checkin",
      path: "../../etc/passwd",
      mime: "image/png",
    });

    expect(() => files.absolutePath(evil)).toThrow(/escapes the photo root/);
    await expect(files.read(evil)).rejects.toThrow(/escapes the photo root/);
    const absolute = await store.domain.repos.photos.create({
      kind: "checkin",
      path: "/etc/passwd",
      mime: "image/png",
    });
    expect(() => files.absolutePath(absolute)).toThrow(/must be relative/);
  });
});
