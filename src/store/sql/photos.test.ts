/**
 * D2: `SqlitePhotosRepo` — metadata rows and the check-in ↔ photo links (SPEC §5.2), including the
 * idempotent attach and the D2-only `remove()` used by the file store.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advance, openTestDomain, HOUR_MS, type TestDomain } from "../testkit.js";

let store: TestDomain;

beforeEach(async () => {
  store = await openTestDomain();
});

afterEach(async () => {
  await store.close();
  store.remove();
});

async function newCheckIn(): Promise<string> {
  const repos = store.domain.repos;
  const assignment = await repos.assignments.create({
    subject: "Математика",
    due_at: "2026-11-25T17:00:00.000Z",
    source: "manual",
  });
  const checkIn = await repos.checkIns.create({ assignment_id: assignment.id, child_user_id: "child-1" });
  return checkIn.id;
}

describe("SqlitePhotosRepo", () => {
  it("creates and reads a photo row", async () => {
    const photo = await store.domain.repos.photos.create({
      kind: "checkin",
      path: "deadbeef.jpg",
      mime: "image/jpeg",
    });

    expect(photo.kind).toBe("checkin");
    expect(photo.path).toBe("deadbeef.jpg");
    expect(photo.mime).toBe("image/jpeg");
    expect(await store.domain.repos.photos.get(photo.id)).toEqual(photo);
    expect(await store.domain.repos.photos.get("nope")).toBeNull();
  });

  it("links photos to a check-in once and lists them oldest first", async () => {
    const repos = store.domain.repos;
    const checkinId = await newCheckIn();
    const first = await repos.photos.create({ kind: "checkin", path: "a.jpg", mime: "image/jpeg" });
    advance(store.clock, HOUR_MS);
    const second = await repos.photos.create({ kind: "checkin", path: "b.jpg", mime: "image/jpeg" });

    await repos.photos.attachToCheckIn(checkinId, first.id);
    await repos.photos.attachToCheckIn(checkinId, second.id);
    await repos.photos.attachToCheckIn(checkinId, first.id); // no-op on re-link

    expect((await repos.photos.listByCheckIn(checkinId)).map((photo) => photo.id)).toEqual([first.id, second.id]);
    expect(await repos.photos.listCheckInIds(first.id)).toEqual([checkinId]);
    expect(await repos.photos.listCheckInIds("nope")).toEqual([]);
  });

  it("detaches without deleting the row", async () => {
    const repos = store.domain.repos;
    const checkinId = await newCheckIn();
    const photo = await repos.photos.create({ kind: "checkin", path: "a.jpg", mime: "image/jpeg" });
    await repos.photos.attachToCheckIn(checkinId, photo.id);

    await repos.photos.detachFromCheckIn(checkinId, photo.id);
    await repos.photos.detachFromCheckIn(checkinId, photo.id); // no-op

    expect(await repos.photos.listByCheckIn(checkinId)).toEqual([]);
    expect(await repos.photos.get(photo.id)).toEqual(photo);
  });

  it("rejects links to unknown check-ins and unknown photos", async () => {
    const repos = store.domain.repos;
    const checkinId = await newCheckIn();
    const photo = await repos.photos.create({ kind: "checkin", path: "a.jpg", mime: "image/jpeg" });

    await expect(repos.photos.attachToCheckIn("nope", photo.id)).rejects.toThrow(/Check-in nope not found/);
    await expect(repos.photos.attachToCheckIn(checkinId, "nope")).rejects.toThrow(/Photo nope not found/);
  });

  it("lists by kind (intake screenshots vs notebook photos)", async () => {
    const repos = store.domain.repos;
    const checkin = await repos.photos.create({ kind: "checkin", path: "a.jpg", mime: "image/jpeg" });
    const screenshot = await repos.photos.create({ kind: "screenshot", path: "b.png", mime: "image/png" });

    expect((await repos.photos.listByKind("checkin")).map((photo) => photo.id)).toEqual([checkin.id]);
    expect((await repos.photos.listByKind("screenshot")).map((photo) => photo.id)).toEqual([screenshot.id]);
  });

  it("a photo may be attached to several check-ins", async () => {
    const repos = store.domain.repos;
    const first = await newCheckIn();
    const second = await newCheckIn();
    const photo = await repos.photos.create({ kind: "screenshot", path: "a.png", mime: "image/png" });

    await repos.photos.attachToCheckIn(first, photo.id);
    await repos.photos.attachToCheckIn(second, photo.id);

    expect(await repos.photos.listCheckInIds(photo.id)).toEqual([first, second]);
    expect((await repos.photos.listByCheckIn(second)).map((p) => p.id)).toEqual([photo.id]);
  });

  it("remove drops the row and every link (D2 extension)", async () => {
    const repos = store.domain.repos;
    const checkinId = await newCheckIn();
    const photo = await repos.photos.create({ kind: "checkin", path: "a.jpg", mime: "image/jpeg" });
    await repos.photos.attachToCheckIn(checkinId, photo.id);

    expect(await repos.photos.remove(photo.id)).toBe(true);
    expect(await repos.photos.remove(photo.id)).toBe(false);
    expect(await repos.photos.get(photo.id)).toBeNull();
    expect(await repos.photos.listByCheckIn(checkinId)).toEqual([]);
    expect(await repos.photos.listCheckInIds(photo.id)).toEqual([]);
  });
});
