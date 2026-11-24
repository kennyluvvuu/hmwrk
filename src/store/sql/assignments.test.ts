/**
 * D2: `SqliteAssignmentsRepo` against a real SQLite file — create/list/update/filter, item bookkeeping and the
 * `hasCheckIn` NOT EXISTS path the reminder task (N1) depends on.
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

describe("SqliteAssignmentsRepo readings", () => {
  it("round-trips an assignment with items", async () => {
    const created = await store.domain.repos.assignments.create({
      subject: "Математика",
      due_at: DUE,
      source: "manual",
      note: "стр. 42",
      items: [{ label: "№ 12" }, { label: "№ 13", note: "сложное" }],
    });

    expect(created.status).toBe("active");
    expect(created.note).toBe("стр. 42");
    expect(created.created_at).toBe(store.clock.current.toISOString());
    expect(created.updated_at).toBe(created.created_at);
    expect(created.items.map((item) => item.label)).toEqual(["№ 12", "№ 13"]);
    expect(created.items.map((item) => item.position)).toEqual([0, 1]);
    expect(created.items[1]?.note).toBe("сложное");
    expect(created.items.every((item) => item.assignment_id === created.id)).toBe(true);

    const again = await store.domain.repos.assignments.getWithItems(created.id);
    expect(again).toEqual(created);
  });

  it("returns copies, not live rows", async () => {
    const created = await store.domain.repos.assignments.create({
      subject: "Физика",
      due_at: DUE,
      source: "journal",
    });
    created.subject = "mutated";

    expect((await store.domain.repos.assignments.get(created.id))?.subject).toBe("Физика");
  });

  it("returns null for unknown ids and throws NotFoundError on writes", async () => {
    const repos = store.domain.repos;

    expect(await repos.assignments.get("nope")).toBeNull();
    expect(await repos.assignments.getWithItems("nope")).toBeNull();
    expect(await repos.assignments.getItem("nope")).toBeNull();
    await expect(repos.assignments.setStatus("nope", "done")).rejects.toThrow(/not found/);
    await expect(repos.assignments.addItems("nope", [{ label: "№ 1" }])).rejects.toThrow(/not found/);
  });

  it("orders the list by due_at and keeps insertion order for equal due dates", async () => {
    const repos = store.domain.repos;
    const late = await repos.assignments.create({ subject: "Позднее", due_at: "2026-11-27T17:00:00.000Z", source: "manual" });
    const firstTie = await repos.assignments.create({ subject: "Первое", due_at: DUE, source: "manual" });
    const secondTie = await repos.assignments.create({ subject: "Второе", due_at: DUE, source: "manual" });
    const early = await repos.assignments.create({ subject: "Раннее", due_at: "2026-11-24T17:00:00.000Z", source: "manual" });

    const listed = await repos.assignments.list();

    expect(listed.map((assignment) => assignment.id)).toEqual([early.id, firstTie.id, secondTie.id, late.id]);
  });
});

describe("SqliteAssignmentsRepo filters", () => {
  it("filters by status, single value or a set", async () => {
    const repos = store.domain.repos;
    const active = await repos.assignments.create({ subject: "Активное", due_at: DUE, source: "manual" });
    const reviewing = await repos.assignments.create({ subject: "На проверке", due_at: DUE, source: "manual" });
    const done = await repos.assignments.create({ subject: "Готово", due_at: DUE, source: "manual" });
    await repos.assignments.setStatus(reviewing.id, "in_review");
    await repos.assignments.setStatus(done.id, "done");

    expect((await repos.assignments.list({ status: "active" })).map((a) => a.id)).toEqual([active.id]);
    expect((await repos.assignments.list({ status: ["in_review", "done"] })).map((a) => a.id)).toEqual([
      reviewing.id,
      done.id,
    ]);
    expect(await repos.assignments.list({ status: [] })).toEqual([]);
    expect((await repos.assignments.listActive()).map((a) => a.id)).toEqual([active.id]);
  });

  it("matches the subject case-insensitively, trimmed, on Unicode", async () => {
    const repos = store.domain.repos;
    const maths = await repos.assignments.create({ subject: "  Математика ", due_at: DUE, source: "manual" });
    await repos.assignments.create({ subject: "Английский", due_at: DUE, source: "manual" });

    expect((await repos.assignments.list({ subject: "мАтЕмАтИкА" })).map((a) => a.id)).toEqual([maths.id]);
    expect(await repos.assignments.list({ subject: "История" })).toEqual([]);
  });

  it("filters by the due window (dueBefore exclusive, dueAfter inclusive)", async () => {
    const repos = store.domain.repos;
    const early = await repos.assignments.create({ subject: "Раннее", due_at: "2026-11-24T17:00:00.000Z", source: "manual" });
    const middle = await repos.assignments.create({ subject: "Среднее", due_at: DUE, source: "manual" });
    const late = await repos.assignments.create({ subject: "Позднее", due_at: "2026-11-26T17:00:00.000Z", source: "manual" });

    expect((await repos.assignments.list({ dueBefore: DUE })).map((a) => a.id)).toEqual([early.id]);
    expect((await repos.assignments.list({ dueAfter: DUE })).map((a) => a.id)).toEqual([middle.id, late.id]);
    expect(
      (await repos.assignments.list({ dueAfter: "2026-11-24T17:00:00.000Z", dueBefore: "2026-11-26T17:00:00.000Z" })).map(
        (a) => a.id,
      ),
    ).toEqual([early.id, middle.id]);
  });

  it("filters hasCheckIn via [NOT] EXISTS", async () => {
    const repos = store.domain.repos;
    const withCheckIn = await repos.assignments.create({ subject: "Сдано", due_at: DUE, source: "manual" });
    const withoutCheckIn = await repos.assignments.create({ subject: "Не сдано", due_at: DUE, source: "manual" });
    await repos.checkIns.create({ assignment_id: withCheckIn.id, child_user_id: "child-1" });

    expect((await repos.assignments.list({ hasCheckIn: false })).map((a) => a.id)).toEqual([withoutCheckIn.id]);
    expect((await repos.assignments.list({ hasCheckIn: true })).map((a) => a.id)).toEqual([withCheckIn.id]);
    // Combined with other conditions: the reminder list of SPEC §5.6.
    expect((await repos.assignments.list({ status: "active", hasCheckIn: false })).map((a) => a.id)).toEqual([
      withoutCheckIn.id,
    ]);
  });

  it("honours limit and offset on the ordered result", async () => {
    const repos = store.domain.repos;
    const ids: string[] = [];
    for (const [index, day] of ["24", "25", "26", "27"].entries()) {
      const created = await repos.assignments.create({
        subject: `Задание ${index}`,
        due_at: `2026-11-${day}T17:00:00.000Z`,
        source: "manual",
      });
      ids.push(created.id);
    }

    expect((await repos.assignments.list({ limit: 2 })).map((a) => a.id)).toEqual(ids.slice(0, 2));
    expect((await repos.assignments.list({ offset: 2 })).map((a) => a.id)).toEqual(ids.slice(2));
    expect((await repos.assignments.list({ offset: 1, limit: 2 })).map((a) => a.id)).toEqual(ids.slice(1, 3));
  });
});

describe("SqliteAssignmentsRepo derived lists", () => {
  it("derives overdue from status + due_at, ignoring in_review", async () => {
    const repos = store.domain.repos;
    const overdue = await repos.assignments.create({ subject: "Просрочено", due_at: "2026-11-23T17:00:00.000Z", source: "manual" });
    const future = await repos.assignments.create({ subject: "Будущее", due_at: "2026-11-30T17:00:00.000Z", source: "manual" });
    const reported = await repos.assignments.create({ subject: "Сдано", due_at: "2026-11-23T17:00:00.000Z", source: "manual" });
    await repos.assignments.setStatus(reported.id, "in_review");

    const now = new Date("2026-11-24T16:00:00.000Z");
    expect((await repos.assignments.listOverdue(now)).map((a) => a.id)).toEqual([overdue.id]);
    // A Date and its ISO form are interchangeable inputs.
    expect((await repos.assignments.listOverdue(now.toISOString())).map((a) => a.id)).toEqual([overdue.id]);
    expect((await repos.assignments.listOverdue(new Date("2026-11-01T00:00:00.000Z")))).toEqual([]);
    expect(future.status).toBe("active");
  });

  it("lists active assignments due in [from, to)", async () => {
    const repos = store.domain.repos;
    const inside = await repos.assignments.create({ subject: "В окне", due_at: "2026-11-25T17:00:00.000Z", source: "manual" });
    await repos.assignments.create({ subject: "Раньше", due_at: "2026-11-24T17:00:00.000Z", source: "manual" });
    await repos.assignments.create({ subject: "Позже", due_at: "2026-11-26T17:00:00.000Z", source: "manual" });
    const reported = await repos.assignments.create({ subject: "Сдано", due_at: "2026-11-25T17:00:00.000Z", source: "manual" });
    await repos.assignments.setStatus(reported.id, "in_review");

    const due = await repos.assignments.listDueWithin("2026-11-25T00:00:00.000Z", "2026-11-26T00:00:00.000Z");
    expect(due.map((a) => a.id)).toEqual([inside.id]);
  });
});

describe("SqliteAssignmentsRepo writes", () => {
  it("appends items after the last position and bumps updated_at", async () => {
    const repos = store.domain.repos;
    const assignment = await repos.assignments.create({
      subject: "Математика",
      due_at: DUE,
      source: "manual",
      items: [{ label: "№ 12" }],
    });
    const before = assignment.updated_at;

    advance(store.clock, HOUR_MS);
    const added = await repos.assignments.addItems(assignment.id, [{ label: "№ 13" }, { label: "№ 14" }]);

    expect(added.map((item) => item.position)).toEqual([1, 2]);
    expect(added.every((item) => item.assignment_id === assignment.id)).toBe(true);
    const reread = await repos.assignments.get(assignment.id);
    expect(reread?.updated_at).not.toBe(before);
    expect((await repos.assignments.listItems(assignment.id)).map((item) => item.label)).toEqual([
      "№ 12",
      "№ 13",
      "№ 14",
    ]);
  });

  it("respects an explicit position and orders by it", async () => {
    const repos = store.domain.repos;
    const assignment = await repos.assignments.create({
      subject: "Математика",
      due_at: DUE,
      source: "manual",
      items: [{ label: "первый" }, { label: "третий", position: 2 }],
    });

    const added = await repos.assignments.addItems(assignment.id, [{ label: "нулевой", position: 0 }, { label: "четвёртый" }]);

    expect(added.map((item) => item.position)).toEqual([0, 4]);
    // «первый» и «нулевой» делят position 0 — как и в фейках, равенство позиции решает `created_at`.
    expect((await repos.assignments.listItems(assignment.id)).map((item) => item.label)).toEqual([
      "первый",
      "нулевой",
      "третий",
      "четвёртый",
    ]);
  });

  it("setStatus writes the raw status and touches updated_at", async () => {
    const repos = store.domain.repos;
    const assignment = await repos.assignments.create({ subject: "Химия", due_at: DUE, source: "manual" });

    advance(store.clock, HOUR_MS);
    const updated = await repos.assignments.setStatus(assignment.id, "in_review");

    expect(updated.status).toBe("in_review");
    expect(updated.updated_at).toBe(store.clock.current.toISOString());
    expect((await repos.assignments.get(assignment.id))?.status).toBe("in_review");
  });

  it("normalises instants to UTC so text comparison stays chronological", async () => {
    const repos = store.domain.repos;
    const offset = await repos.assignments.create({
      subject: "Смещение",
      due_at: "2026-11-25T20:00:00+03:00",
      source: "manual",
    });

    expect(offset.due_at).toBe("2026-11-25T17:00:00.000Z");
  });

  it("rolls the whole create back when a row is rejected", async () => {
    const repos = store.domain.repos;

    await expect(
      repos.assignments.create({ subject: "Плохо", due_at: "not-a-date", source: "manual", items: [{ label: "№ 1" }] }),
    ).rejects.toThrow();
    expect(await repos.assignments.list()).toEqual([]);
    const itemCount = await store.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM assignment_items`);
    expect(itemCount?.count).toBe(0);
  });

  it("lists assignments with their items in one call", async () => {
    const repos = store.domain.repos;
    const a = await repos.assignments.create({ subject: "A", due_at: DUE, source: "manual", items: [{ label: "№ 1" }] });
    const b = await repos.assignments.create({ subject: "B", due_at: DUE, source: "manual" });

    const listed = await repos.assignments.listWithItems();
    const byId = new Map(listed.map((assignment) => [assignment.id, assignment]));

    expect(byId.get(a.id)?.items.map((item) => item.label)).toEqual(["№ 1"]);
    expect(byId.get(b.id)?.items).toEqual([]);
  });

  it("stores the item of getItem with its assignment", async () => {
    const repos = store.domain.repos;
    const assignment = await repos.assignments.create({
      subject: "A",
      due_at: DUE,
      source: "manual",
      items: [{ label: "№ 1" }],
    });
    const [item] = await repos.assignments.listItems(assignment.id);

    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(await repos.assignments.getItem(item.id)).toEqual(item);
  });
});
