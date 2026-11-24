import { describe, expect, it } from "vitest";
import { toIso } from "./dates.js";
import { ConflictError, InvalidTransitionError, NotFoundError } from "./errors.js";
import { createInMemoryRepos, createMemoryStore, loadCheckInWithPhotos } from "./fakes.js";
import type { InMemoryRepos } from "./fakes.js";
import type { NewAssignmentItemInput } from "./repo.js";
import { applyAssignmentAction } from "./status.js";

const START = new Date(2026, 10, 24, 9, 0, 0, 0);

function setup(): { repos: InMemoryRepos; advance: (ms: number) => void; now: () => Date } {
  let current = new Date(START.getTime());
  const repos = createInMemoryRepos({ now: () => current });
  return {
    repos,
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

const HOUR = 60 * 60 * 1000;

async function seedAssignment(
  repos: InMemoryRepos,
  overrides: { subject?: string; dueInHours?: number; items?: NewAssignmentItemInput[] } = {},
) {
  const due = new Date(START.getTime() + (overrides.dueInHours ?? 24) * HOUR);
  return repos.assignments.create({
    subject: overrides.subject ?? "Математика",
    due_at: toIso(due),
    source: "manual",
    items: overrides.items ?? [{ label: "№ 12" }, { label: "№ 13" }],
  });
}

describe("assignments fake", () => {
  it("creates an active assignment with ordered items", async () => {
    const { repos } = setup();
    const assignment = await seedAssignment(repos, { items: [{ label: "№ 12" }, { label: "№ 13", note: "со звёздочкой" }] });

    expect(assignment.status).toBe("active");
    expect(assignment.source).toBe("manual");
    expect(assignment.note).toBeNull();
    expect(assignment.items.map((item) => item.label)).toEqual(["№ 12", "№ 13"]);
    expect(assignment.items.map((item) => item.position)).toEqual([0, 1]);
    expect(assignment.items[1]?.note).toBe("со звёздочкой");
  });

  it("appends items after the existing ones and bumps updated_at", async () => {
    const { repos, advance } = setup();
    const created = await seedAssignment(repos);
    advance(HOUR);

    const added = await repos.assignments.addItems(created.id, [{ label: "№ 14" }]);
    expect(added[0]?.position).toBe(2);

    const reloaded = await repos.assignments.getWithItems(created.id);
    expect(reloaded?.items).toHaveLength(3);
    expect(reloaded?.updated_at).toBe(toIso(new Date(START.getTime() + HOUR)));
  });

  it("filters by status, subject and due window, ordered by due_at", async () => {
    const { repos } = setup();
    const soon = await seedAssignment(repos, { subject: "Математика", dueInHours: 5 });
    const later = await seedAssignment(repos, { subject: "Английский", dueInHours: 30 });
    const past = await seedAssignment(repos, { subject: "История", dueInHours: -2 });

    const all = await repos.assignments.list();
    expect(all.map((row) => row.id)).toEqual([past.id, soon.id, later.id]);

    expect((await repos.assignments.list({ status: "active" })).map((row) => row.id)).toEqual([past.id, soon.id, later.id]);
    expect((await repos.assignments.list({ subject: " математика " })).map((row) => row.id)).toEqual([soon.id]);
    expect((await repos.assignments.list({ limit: 2 })).map((row) => row.id)).toEqual([past.id, soon.id]);
    expect((await repos.assignments.list({ offset: 1, limit: 1 })).map((row) => row.id)).toEqual([soon.id]);

    const cutoff = toIso(new Date(START.getTime() + 10 * HOUR));
    expect((await repos.assignments.list({ dueBefore: cutoff })).map((row) => row.id)).toEqual([past.id, soon.id]);
    expect((await repos.assignments.list({ dueAfter: cutoff })).map((row) => row.id)).toEqual([later.id]);

    await repos.assignments.setStatus(later.id, "done");
    expect((await repos.assignments.list({ status: "done" })).map((row) => row.id)).toEqual([later.id]);
    expect((await repos.assignments.list({ status: ["active", "done"] }))).toHaveLength(3);
  });

  it("filters by presence of a check-in (reminder horizon)", async () => {
    const { repos } = setup();
    const reported = await seedAssignment(repos, { subject: "Математика" });
    const pending = await seedAssignment(repos, { subject: "Английский" });
    await repos.checkIns.create({ assignment_id: reported.id, child_user_id: "child-1" });

    expect((await repos.assignments.list({ hasCheckIn: false })).map((row) => row.id)).toEqual([pending.id]);
    expect((await repos.assignments.list({ hasCheckIn: true })).map((row) => row.id)).toEqual([reported.id]);
  });

  it("derives overdue and the due window from stored status", async () => {
    const { repos } = setup();
    const overdue = await seedAssignment(repos, { subject: "История", dueInHours: -2 });
    const dueSoon = await seedAssignment(repos, { subject: "Математика", dueInHours: 5 });
    const far = await seedAssignment(repos, { subject: "Английский", dueInHours: 40 });

    expect((await repos.assignments.listActive()).map((row) => row.id)).toEqual([overdue.id, dueSoon.id, far.id]);
    expect((await repos.assignments.listOverdue(START)).map((row) => row.id)).toEqual([overdue.id]);

    const windowEnd = new Date(START.getTime() + 24 * HOUR);
    expect((await repos.assignments.listDueWithin(START, windowEnd)).map((row) => row.id)).toEqual([dueSoon.id]);

    await repos.assignments.setStatus(overdue.id, "in_review");
    expect(await repos.assignments.listOverdue(START)).toHaveLength(0);
  });

  it("returns null for missing rows and copies for found ones", async () => {
    const { repos } = setup();
    const created = await seedAssignment(repos);

    expect(await repos.assignments.get("missing")).toBeNull();
    expect(await repos.assignments.getWithItems("missing")).toBeNull();
    expect(await repos.assignments.getItem("missing")).toBeNull();

    const copy = await repos.assignments.get(created.id);
    expect(copy).not.toBeNull();
    if (copy) copy.status = "done";
    expect((await repos.assignments.get(created.id))?.status).toBe("active");
  });

  it("throws NotFoundError when mutating an unknown assignment", async () => {
    const { repos } = setup();
    await expect(repos.assignments.addItems("missing", [{ label: "№ 1" }])).rejects.toBeInstanceOf(NotFoundError);
    await expect(repos.assignments.setStatus("missing", "done")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("check-ins fake", () => {
  it("keeps the history and exposes the latest report", async () => {
    const { repos, advance } = setup();
    const assignment = await seedAssignment(repos);
    const first = await repos.checkIns.create({ assignment_id: assignment.id, child_user_id: "child-1" });
    advance(HOUR);
    const second = await repos.checkIns.create({
      assignment_id: assignment.id,
      child_user_id: "child-1",
      comment: "№ 13 не уверен",
    });

    expect((await repos.checkIns.listByAssignment(assignment.id)).map((row) => row.id)).toEqual([first.id, second.id]);
    expect((await repos.checkIns.latestForAssignment(assignment.id))?.id).toBe(second.id);
    expect((await repos.checkIns.listForChild("child-1"))).toHaveLength(2);
    expect(await repos.checkIns.listForChild("child-2")).toHaveLength(0);
    expect(second.comment).toBe("№ 13 не уверен");
    expect(await repos.checkIns.get("missing")).toBeNull();
  });

  it("filters by time window and bumps updated_at on touch", async () => {
    const { repos, advance } = setup();
    const assignment = await seedAssignment(repos);
    const checkIn = await repos.checkIns.create({ assignment_id: assignment.id, child_user_id: "child-1" });

    advance(2 * HOUR);
    const touched = await repos.checkIns.touch(checkIn.id);
    expect(touched.updated_at).toBe(toIso(new Date(START.getTime() + 2 * HOUR)));
    expect(touched.created_at).toBe(checkIn.created_at);

    expect((await repos.checkIns.listSince(START)).map((row) => row.id)).toEqual([checkIn.id]);
    expect(await repos.checkIns.listSince(new Date(START.getTime() + HOUR))).toHaveLength(0);
    await expect(repos.checkIns.touch("missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("photos fake", () => {
  it("stores photos, links them to check-ins and detaches", async () => {
    const { repos } = setup();
    const assignment = await seedAssignment(repos);
    const checkIn = await repos.checkIns.create({ assignment_id: assignment.id, child_user_id: "child-1" });
    const photo = await repos.photos.create({ kind: "checkin", path: "2026/11/notebook.jpg", mime: "image/jpeg" });
    const screenshot = await repos.photos.create({ kind: "screenshot", path: "2026/11/journal.png", mime: "image/png" });

    await repos.photos.attachToCheckIn(checkIn.id, photo.id);
    await repos.photos.attachToCheckIn(checkIn.id, photo.id); // idempotent

    expect((await repos.photos.listByCheckIn(checkIn.id)).map((row) => row.id)).toEqual([photo.id]);
    expect((await repos.photos.listByKind("screenshot")).map((row) => row.id)).toEqual([screenshot.id]);
    expect(await repos.photos.listCheckInIds(photo.id)).toEqual([checkIn.id]);
    expect(await repos.photos.get(photo.id)).toEqual(photo);

    const loaded = await loadCheckInWithPhotos(repos, checkIn.id);
    expect(loaded?.photos).toHaveLength(1);
    expect(await loadCheckInWithPhotos(repos, "missing")).toBeNull();

    await repos.photos.detachFromCheckIn(checkIn.id, photo.id);
    expect(await repos.photos.listByCheckIn(checkIn.id)).toHaveLength(0);
    expect(await repos.photos.get(photo.id)).not.toBeNull();
  });

  it("refuses to link unknown rows", async () => {
    const { repos } = setup();
    await expect(repos.photos.attachToCheckIn("missing", "missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("verifications fake", () => {
  async function seedDraft(repos: InMemoryRepos, label = "№ 12") {
    const assignment = await seedAssignment(repos, { items: [{ label }] });
    const checkIn = await repos.checkIns.create({ assignment_id: assignment.id, child_user_id: "child-1" });
    const item = (await repos.assignments.listItems(assignment.id))[0];
    const draft = await repos.verifications.createDraft({
      checkin_id: checkIn.id,
      summary: "почти всё верно",
      model: "mistral/deepseek",
      findings: [{ item_id: item?.id ?? "missing", verdict: "wrong", comment: "ответ 42 вместо 24" }],
    });
    return { assignment, checkIn, item, draft };
  }

  it("stores drafts with findings", async () => {
    const { repos } = setup();
    const { draft, item } = await seedDraft(repos);

    expect(draft.status).toBe("draft");
    expect(draft.decided_at).toBeNull();
    expect(draft.decided_by_user_id).toBeNull();
    expect(draft.findings).toHaveLength(1);
    expect(draft.findings[0]?.verdict).toBe("wrong");
    expect(draft.findings[0]?.item_id).toBe(item?.id);
    expect(await repos.verifications.findings(draft.id)).toHaveLength(1);
    expect(await repos.verifications.getWithFindings("missing")).toBeNull();
  });

  it("lists drafts by assignment and keeps only the latest per check-in as pending", async () => {
    const { repos, advance } = setup();
    const { assignment, checkIn, item, draft } = await seedDraft(repos);

    expect((await repos.verifications.listByAssignment(assignment.id)).map((row) => row.id)).toEqual([draft.id]);
    expect((await repos.verifications.listDrafts()).map((row) => row.id)).toEqual([draft.id]);
    expect((await repos.verifications.listPending()).map((row) => row.id)).toEqual([draft.id]);

    advance(HOUR);
    const recomputed = await repos.verifications.createDraft({
      checkin_id: checkIn.id,
      summary: "пересчитал после нового фото",
      model: "mistral/deepseek",
      findings: [{ item_id: item?.id ?? "missing", verdict: "ok" }],
    });

    expect((await repos.verifications.listPending()).map((row) => row.id)).toEqual([recomputed.id]);
    expect((await repos.verifications.latestDraftForCheckIn(checkIn.id))?.id).toBe(recomputed.id);
    expect(await repos.verifications.listByAssignment(assignment.id)).toHaveLength(2);

    await repos.verifications.decide(recomputed.id, "approved", "parent-1");
    expect(await repos.verifications.listPending()).toHaveLength(0);
    expect(await repos.verifications.latestDraftForCheckIn(checkIn.id)).toBeNull();
    expect((await repos.verifications.latestForCheckIn(checkIn.id))?.id).toBe(recomputed.id);
  });

  it("decides a draft once and rejects a second decision", async () => {
    const { repos, advance } = setup();
    const { draft } = await seedDraft(repos);
    advance(HOUR);

    const decided = await repos.verifications.decide(draft.id, "approved", "parent-1");
    expect(decided.status).toBe("approved");
    expect(decided.decided_at).toBe(toIso(new Date(START.getTime() + HOUR)));
    expect(decided.decided_by_user_id).toBe("parent-1");

    await expect(repos.verifications.decide(draft.id, "dismissed", "parent-1")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await expect(repos.verifications.decide("missing", "approved", "parent-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("filters verdicts by status and joins through check-ins", async () => {
    const { repos } = setup();
    const { assignment, draft } = await seedDraft(repos);
    const other = await seedAssignment(repos, { subject: "Английский" });
    const otherCheckIn = await repos.checkIns.create({ assignment_id: other.id, child_user_id: "child-1" });
    await repos.verifications.createDraft({
      checkin_id: otherCheckIn.id,
      summary: "всё хорошо",
      model: "mistral/deepseek",
      findings: [],
    });

    await repos.verifications.decide(draft.id, "approved", "parent-1");

    expect(await repos.verifications.listByAssignment(assignment.id)).toHaveLength(1);
    expect(await repos.verifications.listByAssignment(assignment.id, { status: "draft" })).toHaveLength(0);
    expect(await repos.verifications.listByAssignment(assignment.id, { status: "approved" })).toHaveLength(1);
    expect(await repos.verifications.listPending()).toHaveLength(1);

    expect(await repos.verifications.list()).toHaveLength(2);
    expect(await repos.verifications.list({ status: "approved" })).toHaveLength(1);
    expect(await repos.verifications.list({ status: ["draft", "dismissed"] })).toHaveLength(1);
    expect(await repos.verifications.list({ limit: 1 })).toHaveLength(1);
    expect(await repos.verifications.list({ checkinId: otherCheckIn.id })).toHaveLength(1);
  });
});

describe("full cycle over fakes", () => {
  it("runs report → draft → approve → done and dismiss → active", async () => {
    const { repos } = setup();
    const assignment = await seedAssignment(repos);
    const checkIn = await repos.checkIns.create({ assignment_id: assignment.id, child_user_id: "child-1" });

    const reported = await repos.assignments.setStatus(
      assignment.id,
      applyAssignmentAction(assignment.status, "report"),
    );
    expect(reported.status).toBe("in_review");

    const draft = await repos.verifications.createDraft({
      checkin_id: checkIn.id,
      summary: "проверено",
      model: "mistral/deepseek",
      findings: [],
    });

    await repos.assignments.setStatus(assignment.id, applyAssignmentAction(reported.status, "dismiss"));
    expect((await repos.assignments.get(assignment.id))?.status).toBe("active");

    await repos.assignments.setStatus(assignment.id, applyAssignmentAction("active", "report"));
    await repos.verifications.decide(draft.id, "approved", "parent-1");
    const done = await repos.assignments.setStatus(assignment.id, applyAssignmentAction("in_review", "approve"));
    expect(done.status).toBe("done");
    expect((await repos.assignments.listOverdue(START))).toHaveLength(0);
  });
});

describe("users fake", () => {
  it("maps OpenWebUI accounts to roles", async () => {
    const { repos } = setup();
    const parent = await repos.users.create({ openwebui_user_id: "owui-parent", role: "parent", name: "Мама" });

    expect(await repos.users.getByOpenWebUiId("owui-parent")).toEqual(parent);
    expect(await repos.users.getByOpenWebUiId("unknown")).toBeNull();
    expect((await repos.users.listByRole("parent")).map((row) => row.id)).toEqual([parent.id]);
    expect(await repos.users.listByRole("child")).toHaveLength(0);

    const updated = await repos.users.upsert({ openwebui_user_id: "owui-parent", role: "child", name: "Мама" });
    expect(updated.id).toBe(parent.id);
    expect(updated.role).toBe("child");

    const child = await repos.users.upsert({ openwebui_user_id: "owui-child", role: "child", name: "Петя" });
    expect(child.role).toBe("child");
    expect(await repos.users.list()).toHaveLength(2);

    expect((await repos.users.setRole(child.id, "parent")).role).toBe("parent");
    await expect(repos.users.create({ openwebui_user_id: "owui-child", role: "child", name: "Дубль" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(repos.users.setRole("missing", "parent")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("telegram bindings fake", () => {
  it("binds one chat per user", async () => {
    const { repos } = setup();
    const binding = await repos.tgBindings.upsert({ user_id: "user-1", chat_id: "111" });
    expect(binding.chat_id).toBe("111");

    const rebound = await repos.tgBindings.upsert({ user_id: "user-1", chat_id: "222" });
    expect(rebound.chat_id).toBe("222");
    expect(await repos.tgBindings.list()).toHaveLength(1);
    expect((await repos.tgBindings.getByUserId("user-1"))?.chat_id).toBe("222");
    expect(await repos.tgBindings.getByUserId("user-2")).toBeNull();

    expect(await repos.tgBindings.remove("user-1")).toBe(true);
    expect(await repos.tgBindings.remove("user-1")).toBe(false);
  });
});

describe("settings fake", () => {
  it("returns defaults until a validated value is set", async () => {
    const { repos } = setup();
    const initial = await repos.settings.getAll();
    expect(initial.reminder_time).toBe("19:00");
    expect(initial.digest_time).toBe("21:00");
    expect(initial.default_due).toEqual({ offset_days: 1, time: "20:00" });
    expect(initial.paused_until).toBeNull();
    expect(await repos.settings.get("reminder_time")).toBe("19:00");

    const afterSet = await repos.settings.set("reminder_time", "08:00");
    expect(afterSet.reminder_time).toBe("08:00");
    expect(await repos.settings.get("reminder_time")).toBe("08:00");

    await repos.settings.update({ digest_time: "22:15", paused_until: "2026-01-09" });
    const updated = await repos.settings.getAll();
    expect(updated.digest_time).toBe("22:15");
    expect(updated.paused_until).toBe("2026-01-09");
    expect(updated.reminder_time).toBe("08:00");
  });

  it("normalizes and rejects invalid values on write", async () => {
    const { repos } = setup();
    expect((await repos.settings.set("digest_time", "9:05")).digest_time).toBe("09:05");
    await expect(repos.settings.set("reminder_time", "25:00")).rejects.toBeInstanceOf(Error);
    expect((await repos.settings.getAll()).reminder_time).toBe("19:00");
  });

  it("accepts preloaded overrides and does not leak the default object", async () => {
    const repos = createInMemoryRepos({ settings: { paused_until: "2026-02-01" } });
    const settings = await repos.settings.getAll();
    expect(settings.paused_until).toBe("2026-02-01");
    settings.default_due.time = "06:00";
    expect((await repos.settings.get("default_due")).time).toBe("20:00");
  });
});

describe("store sharing", () => {
  it("puts every fake on one store", async () => {
    const store = createMemoryStore();
    const repos = createInMemoryRepos({ store });
    const assignment = await seedAssignment(repos);
    expect(store.assignments.map((row) => row.id)).toEqual([assignment.id]);
    expect(repos.raw).toBe(store);
    expect(repos.store).toBe(store);
  });
});
