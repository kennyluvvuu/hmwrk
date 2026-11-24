/**
 * D2: `SqliteCheckInsRepo` — ordering, latest, per-child windows and `touch()` (the verdict-recompute hook).
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

const DUE = "2026-11-25T17:00:00.000Z";

async function newAssignment(subject = "Математика"): Promise<string> {
  const assignment = await store.domain.repos.assignments.create({ subject, due_at: DUE, source: "manual" });
  return assignment.id;
}

describe("SqliteCheckInsRepo", () => {
  it("round-trips a check-in with its comment", async () => {
    const assignmentId = await newAssignment();
    const checkIn = await store.domain.repos.checkIns.create({
      assignment_id: assignmentId,
      child_user_id: "child-1",
      comment: "сделал, но №13 не уверен",
    });

    expect(checkIn.assignment_id).toBe(assignmentId);
    expect(checkIn.comment).toBe("сделал, но №13 не уверен");
    expect(checkIn.created_at).toBe(store.clock.current.toISOString());
    expect(checkIn.updated_at).toBe(checkIn.created_at);
    expect(await store.domain.repos.checkIns.get(checkIn.id)).toEqual(checkIn);
    expect(await store.domain.repos.checkIns.get("nope")).toBeNull();
  });

  it("defaults the comment to null", async () => {
    const checkIn = await store.domain.repos.checkIns.create({
      assignment_id: await newAssignment(),
      child_user_id: "child-1",
    });

    expect(checkIn.comment).toBeNull();
  });

  it("lists check-ins of an assignment oldest first and returns the latest", async () => {
    const repos = store.domain.repos;
    const assignmentId = await newAssignment();
    const other = await newAssignment("Физика");
    const first = await repos.checkIns.create({ assignment_id: assignmentId, child_user_id: "child-1" });
    advance(store.clock, HOUR_MS);
    const second = await repos.checkIns.create({ assignment_id: assignmentId, child_user_id: "child-1", comment: "ещё раз" });
    await repos.checkIns.create({ assignment_id: other, child_user_id: "child-1" });

    expect((await repos.checkIns.listByAssignment(assignmentId)).map((c) => c.id)).toEqual([first.id, second.id]);
    expect((await repos.checkIns.latestForAssignment(assignmentId))?.id).toBe(second.id);
    expect(await repos.checkIns.latestForAssignment("nope")).toBeNull();
    expect(await repos.checkIns.listByAssignment("nope")).toEqual([]);
  });

  it("filters a child's check-ins by the [since, until) window and limit", async () => {
    const repos = store.domain.repos;
    const assignmentId = await newAssignment();
    const windowStart = store.clock.current;
    const old = await repos.checkIns.create({ assignment_id: assignmentId, child_user_id: "child-1" });
    advance(store.clock, HOUR_MS);
    const inside = await repos.checkIns.create({ assignment_id: assignmentId, child_user_id: "child-1" });
    advance(store.clock, HOUR_MS);
    const later = await repos.checkIns.create({ assignment_id: assignmentId, child_user_id: "child-2" });

    const forChild = await repos.checkIns.listForChild("child-1");
    expect(forChild.map((c) => c.id)).toEqual([old.id, inside.id]);

    const since = await repos.checkIns.listForChild("child-1", { since: new Date(windowStart.getTime() + 1).toISOString() });
    expect(since.map((c) => c.id)).toEqual([inside.id]);

    const until = await repos.checkIns.listForChild("child-1", { until: store.clock.current.toISOString() });
    expect(until.map((c) => c.id)).toEqual([old.id, inside.id]);

    expect((await repos.checkIns.listForChild("child-1", { limit: 1 })).map((c) => c.id)).toEqual([old.id]);
    expect(later.child_user_id).toBe("child-2");
  });

  it("lists every check-in since an instant", async () => {
    const repos = store.domain.repos;
    const assignmentId = await newAssignment();
    const cut = new Date(store.clock.current.getTime() + HOUR_MS);
    await repos.checkIns.create({ assignment_id: assignmentId, child_user_id: "child-1" });
    advance(store.clock, 2 * HOUR_MS);
    const fresh = await repos.checkIns.create({ assignment_id: assignmentId, child_user_id: "child-2" });

    expect((await repos.checkIns.listSince(cut)).map((c) => c.id)).toEqual([fresh.id]);
    expect(await repos.checkIns.listSince("2027-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("touch bumps updated_at and keeps created_at", async () => {
    const repos = store.domain.repos;
    const checkIn = await repos.checkIns.create({ assignment_id: await newAssignment(), child_user_id: "child-1" });

    advance(store.clock, HOUR_MS);
    const touched = await repos.checkIns.touch(checkIn.id);

    expect(touched.created_at).toBe(checkIn.created_at);
    expect(touched.updated_at).toBe(store.clock.current.toISOString());
    expect((await repos.checkIns.get(checkIn.id))?.updated_at).toBe(touched.updated_at);
    await expect(repos.checkIns.touch("nope")).rejects.toThrow(/not found/);
  });
});
