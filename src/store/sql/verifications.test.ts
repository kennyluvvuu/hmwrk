/**
 * D2: `SqliteVerificationsRepo` — drafts with findings, the «latest draft per check-in» pending query and the
 * decision transitions (SPEC §5.4).
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

interface Fixture {
  readonly assignmentId: string;
  readonly checkinId: string;
  readonly itemId: string;
}

async function fixture(subject = "Математика"): Promise<Fixture> {
  const repos = store.domain.repos;
  const assignment = await repos.assignments.create({
    subject,
    due_at: "2026-11-25T17:00:00.000Z",
    source: "manual",
    items: [{ label: "№ 12" }],
  });
  const checkIn = await repos.checkIns.create({ assignment_id: assignment.id, child_user_id: "child-1" });
  const items = await repos.assignments.listItems(assignment.id);
  const itemId = items[0]?.id;
  if (itemId === undefined) throw new Error("fixture: assignment has no items");
  return { assignmentId: assignment.id, checkinId: checkIn.id, itemId };
}

describe("SqliteVerificationsRepo drafts", () => {
  it("creates a draft with its findings", async () => {
    const repos = store.domain.repos;
    const { checkinId, itemId } = await fixture();

    const draft = await repos.verifications.createDraft({
      checkin_id: checkinId,
      summary: "№12 решён верно",
      model: "deepseek-v4-1-flash-1017",
      findings: [{ item_id: itemId, verdict: "ok", comment: "верно" }],
    });

    expect(draft.status).toBe("draft");
    expect(draft.decided_at).toBeNull();
    expect(draft.decided_by_user_id).toBeNull();
    expect(draft.model).toBe("deepseek-v4-1-flash-1017");
    expect(draft.findings).toEqual([
      { verification_id: draft.id, item_id: itemId, verdict: "ok", comment: "верно" },
    ]);
    expect(await repos.verifications.get(draft.id)).not.toHaveProperty("findings");
    expect(await repos.verifications.getWithFindings(draft.id)).toEqual(draft);
    expect(await repos.verifications.getWithFindings("nope")).toBeNull();
  });

  it("accepts a draft whose finding names an item unknown to the store", async () => {
    const repos = store.domain.repos;
    const { checkinId } = await fixture();

    const draft = await repos.verifications.createDraft({
      checkin_id: checkinId,
      summary: "модель сослалась на несуществующий пункт",
      model: "m",
      findings: [{ item_id: "item-from-the-model", verdict: "unclear" }],
    });

    expect(draft.findings).toHaveLength(1);
    expect(draft.findings[0]?.comment).toBeNull();
  });

  it("stores one finding per item (re-insert replaces, does not duplicate)", async () => {
    const repos = store.domain.repos;
    const { checkinId, itemId } = await fixture();

    const draft = await repos.verifications.createDraft({
      checkin_id: checkinId,
      summary: "дубль пункта",
      model: "m",
      findings: [
        { item_id: itemId, verdict: "ok" },
        { item_id: itemId, verdict: "wrong", comment: "на самом деле нет" },
      ],
    });

    expect(draft.findings).toHaveLength(1);
    expect(draft.findings[0]?.verdict).toBe("wrong");
  });
});

describe("SqliteVerificationsRepo latest and pending", () => {
  it("latestForCheckIn follows creation order, not summary", async () => {
    const repos = store.domain.repos;
    const { checkinId } = await fixture();
    const first = await repos.verifications.createDraft({ checkin_id: checkinId, summary: "первый", model: "m", findings: [] });
    advance(store.clock, HOUR_MS);
    const second = await repos.verifications.createDraft({ checkin_id: checkinId, summary: "второй", model: "m", findings: [] });

    expect((await repos.verifications.listByCheckIn(checkinId)).map((v) => v.id)).toEqual([first.id, second.id]);
    expect((await repos.verifications.latestForCheckIn(checkinId))?.id).toBe(second.id);
    expect((await repos.verifications.latestDraftForCheckIn(checkinId))?.id).toBe(second.id);
    expect(await repos.verifications.latestForCheckIn("nope")).toBeNull();
    expect(await repos.verifications.listByCheckIn("nope")).toEqual([]);
  });

  it("listPending keeps only the latest draft per check-in", async () => {
    const repos = store.domain.repos;
    const a = await fixture("Математика");
    const b = await fixture("Физика");

    const superseded = await repos.verifications.createDraft({ checkin_id: a.checkinId, summary: "старый", model: "m", findings: [] });
    advance(store.clock, HOUR_MS);
    const current = await repos.verifications.createDraft({ checkin_id: a.checkinId, summary: "новый", model: "m", findings: [] });
    advance(store.clock, HOUR_MS);
    const other = await repos.verifications.createDraft({ checkin_id: b.checkinId, summary: "другой", model: "m", findings: [] });

    const pending = await repos.verifications.listPending();
    expect(pending.map((v) => v.id)).toEqual([current.id, other.id]);
    expect(pending.map((v) => v.id)).not.toContain(superseded.id);

    // Every draft is still listed by listDrafts — «все черновики» is a different question.
    expect((await repos.verifications.listDrafts()).map((v) => v.id)).toEqual([
      superseded.id,
      current.id,
      other.id,
    ]);
  });

  it("a decided latest verification takes the check-in out of the pending queue", async () => {
    const repos = store.domain.repos;
    const a = await fixture("Математика");
    const b = await fixture("Физика");
    const decided = await repos.verifications.createDraft({ checkin_id: a.checkinId, summary: "решаем", model: "m", findings: [] });
    advance(store.clock, HOUR_MS);
    const open = await repos.verifications.createDraft({ checkin_id: b.checkinId, summary: "ждёт", model: "m", findings: [] });

    await repos.verifications.decide(decided.id, "approved", "parent-1");

    expect((await repos.verifications.listPending()).map((v) => v.id)).toEqual([open.id]);
    expect(await repos.verifications.latestDraftForCheckIn(a.checkinId)).toBeNull();
    expect((await repos.verifications.latestForCheckIn(a.checkinId))?.status).toBe("approved");
  });

  it("listPending survives a frozen clock (ties are broken by insertion order)", async () => {
    const repos = store.domain.repos;
    const a = await fixture();

    const earlier = await repos.verifications.createDraft({ checkin_id: a.checkinId, summary: "раньше", model: "m", findings: [] });
    const later = await repos.verifications.createDraft({ checkin_id: a.checkinId, summary: "позже", model: "m", findings: [] });

    expect(earlier.created_at).toBe(later.created_at);
    expect((await repos.verifications.listPending()).map((v) => v.id)).toEqual([later.id]);
  });
});

describe("SqliteVerificationsRepo filters", () => {
  it("lists by assignment through its check-ins, with an optional status filter", async () => {
    const repos = store.domain.repos;
    const a = await fixture("Математика");
    const b = await fixture("Физика");
    const mine = await repos.verifications.createDraft({ checkin_id: a.checkinId, summary: "моё", model: "m", findings: [] });
    const foreign = await repos.verifications.createDraft({ checkin_id: b.checkinId, summary: "чужое", model: "m", findings: [] });
    await repos.verifications.decide(foreign.id, "dismissed", "parent-1");

    expect((await repos.verifications.listByAssignment(a.assignmentId)).map((v) => v.id)).toEqual([mine.id]);
    expect((await repos.verifications.listByAssignment(b.assignmentId, { status: "dismissed" })).map((v) => v.id)).toEqual([
      foreign.id,
    ]);
    expect(await repos.verifications.listByAssignment(b.assignmentId, { status: "draft" })).toEqual([]);
    expect(await repos.verifications.listByAssignment("nope")).toEqual([]);
  });

  it("lists globally with checkinId, status set and limit", async () => {
    const repos = store.domain.repos;
    const a = await fixture("Математика");
    const b = await fixture("Физика");
    const first = await repos.verifications.createDraft({ checkin_id: a.checkinId, summary: "1", model: "m", findings: [] });
    advance(store.clock, HOUR_MS);
    const second = await repos.verifications.createDraft({ checkin_id: b.checkinId, summary: "2", model: "m", findings: [] });
    await repos.verifications.decide(second.id, "approved", "parent-1");

    expect((await repos.verifications.list()).map((v) => v.id)).toEqual([first.id, second.id]);
    expect((await repos.verifications.list({ checkinId: b.checkinId })).map((v) => v.id)).toEqual([second.id]);
    expect((await repos.verifications.list({ status: "draft" })).map((v) => v.id)).toEqual([first.id]);
    expect((await repos.verifications.list({ status: ["approved", "dismissed"] })).map((v) => v.id)).toEqual([second.id]);
    expect(await repos.verifications.list({ status: [] })).toEqual([]);
    expect((await repos.verifications.list({ limit: 1 })).map((v) => v.id)).toEqual([first.id]);
  });
});

describe("SqliteVerificationsRepo.decide", () => {
  it("records the decision, the parent and the moment", async () => {
    const repos = store.domain.repos;
    const { checkinId } = await fixture();
    const draft = await repos.verifications.createDraft({ checkin_id: checkinId, summary: "s", model: "m", findings: [] });

    advance(store.clock, HOUR_MS);
    const decided = await repos.verifications.decide(draft.id, "approved", "parent-1");

    expect(decided.status).toBe("approved");
    expect(decided.decided_at).toBe(store.clock.current.toISOString());
    expect(decided.decided_by_user_id).toBe("parent-1");
  });

  it("accepts an explicit decision instant and a null parent", async () => {
    const repos = store.domain.repos;
    const { checkinId } = await fixture();
    const draft = await repos.verifications.createDraft({ checkin_id: checkinId, summary: "s", model: "m", findings: [] });

    const decided = await repos.verifications.decide(draft.id, "dismissed", null, "2026-12-01T10:00:00.000Z");

    expect(decided.status).toBe("dismissed");
    expect(decided.decided_at).toBe("2026-12-01T10:00:00.000Z");
    expect(decided.decided_by_user_id).toBeNull();
  });

  it("refuses a second decision and an unknown id", async () => {
    const repos = store.domain.repos;
    const { checkinId } = await fixture();
    const draft = await repos.verifications.createDraft({ checkin_id: checkinId, summary: "s", model: "m", findings: [] });

    await repos.verifications.decide(draft.id, "approved", "parent-1");

    await expect(repos.verifications.decide(draft.id, "dismissed", "parent-1")).rejects.toThrow(/approved/);
    await expect(repos.verifications.decide("nope", "approved", null)).rejects.toThrow(/not found/);
    expect((await repos.verifications.findings(draft.id))).toEqual([]);
  });
});
