/**
 * N1 durable reminder/digest tests: in-memory repositories + a fake Telegram sender, a real Harness on
 * temp SQLite, and a fake clock (K9: `HarnessOptions.now` + `setTimer`).
 *
 * The clock is the whole point of the design under test: a scheduled task must park in `sleeping`
 * exactly until the settings' wall-clock time, send on wake, and immediately re-park for the next day —
 * so every assertion reads the task record right after a schedule instead of waiting for real time.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SetTimer, TaskId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHarness, type Core } from "../../contracts/harness.js";
import type { TelegramSender } from "../../contracts/notify.js";
import {
  addLocalDays,
  atLocalTime,
  createInMemoryRepos,
  formatIsoDate,
  toIso,
  type AssignmentWithItems,
  type InMemoryRepos,
  type Repos,
  type Settings,
} from "../../domain/index.js";
import { fauxModels, makeTempDir, silentLogger, testConfig, type TempDir } from "../testkit.js";
import {
  createNotifyExtension,
  createNotifyScheduler,
  nextRunAt,
  type DigestSections,
  type NotifyDeps,
  type NotifyFireResult,
  type NotifyState,
} from "./notify.js";

// ---------------------------------------------------------------------------
// Fake clock (K9)
// ---------------------------------------------------------------------------

interface FakeClock {
  now(): number;
  date(): Date;
  readonly setTimer: SetTimer;
  /** Move the clock forward, running every timer that fires on the way (in time order). */
  advanceTo(target: Date): void;
}

function createFakeClock(start: Date): FakeClock {
  let current = start.getTime();
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];

  const clock: FakeClock = {
    now: () => current,
    date: () => new Date(current),
    setTimer: (callback: () => void, delayMs: number) => {
      const timer = { at: current + delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advanceTo(target: Date) {
      const targetMs = target.getTime();
      for (let guard = 0; guard < 1000; guard += 1) {
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= targetMs)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cancelled = true;
        current = Math.max(current, due.at);
        due.callback();
      }
      current = Math.max(current, targetMs);
    },
  };
  return clock;
}

/** The household's local noon on a fixed day; every expected instant derives from it. */
const START = new Date(2026, 10, 24, 12, 0, 0);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let temp: TempDir;
let core: Core | undefined;

beforeEach(() => {
  temp = makeTempDir("hmwrk-notify-");
});

afterEach(async () => {
  if (core !== undefined) {
    await core.close().catch(() => undefined);
    core = undefined;
  }
  temp.remove();
});

interface FakeSender {
  readonly sender: TelegramSender;
  readonly sent: { chatId: string; text: string }[];
}

function fakeSender(behaviour: { fail?: boolean } = {}): FakeSender {
  const sent: { chatId: string; text: string }[] = [];
  return {
    sent,
    sender: {
      async sendMessage(input) {
        if (behaviour.fail === true) throw new Error("telegram is down");
        sent.push(input);
      },
    },
  };
}

const renderReminder = (assignments: readonly AssignmentWithItems[]): string =>
  `напоминание: ${assignments.map((assignment) => assignment.subject).join(", ")}`;

const renderDigest = (sections: DigestSections): string =>
  [
    "дайджест",
    `сдано:${sections.submittedToday.length}`,
    `просрочено:${sections.overdue.length}`,
    `ждут:${sections.pendingVerdicts.length}`,
    `парсер:${sections.parserDrafts.length}`,
  ].join(" ");

interface Household {
  readonly repos: InMemoryRepos;
  readonly clock: FakeClock;
}

function household(options: { settings?: Partial<Settings>; parentChat?: string | null; childChat?: string | null } = {}): Household {
  const clock = createFakeClock(START);
  const repos = createInMemoryRepos({ now: () => clock.date(), settings: options.settings });
  return { repos, clock };
}

async function bindChats(
  repos: Repos,
  chats: { parentChat?: string | null; childChat?: string | null },
): Promise<{ parentId: string; childId: string }> {
  const parent = await repos.users.create({ openwebui_user_id: "owui-parent", role: "parent", name: "Мама" });
  const child = await repos.users.create({ openwebui_user_id: "owui-child", role: "child", name: "Петя" });
  const parentChat = chats.parentChat === undefined ? "chat-parent" : chats.parentChat;
  const childChat = chats.childChat === undefined ? "chat-child" : chats.childChat;
  if (parentChat !== null) await repos.tgBindings.upsert({ user_id: parent.id, chat_id: parentChat });
  if (childChat !== null) await repos.tgBindings.upsert({ user_id: child.id, chat_id: childChat });
  return { parentId: parent.id, childId: child.id };
}

/**
 * Active assignment due in the reminder horizon (today 20:00, i.e. inside the next 24 h), optionally
 * already reported.
 */
async function seedDueAssignment(
  repos: Repos,
  clock: FakeClock,
  options: { due?: Date; checkIn?: boolean; childId?: string } = {},
): Promise<AssignmentWithItems> {
  const due = options.due ?? atLocalTime(clock.date(), "20:00");
  const assignment = await repos.assignments.create({
    subject: "Математика",
    due_at: toIso(due),
    source: "manual",
    items: [{ label: "№ 12" }],
  });
  if (options.checkIn === true) {
    await repos.checkIns.create({
      assignment_id: assignment.id,
      child_user_id: options.childId ?? "child",
      comment: "сделал",
    });
  }
  return assignment;
}

async function openCore(
  fixture: Household,
  sender: TelegramSender,
  overrides: Partial<Pick<NotifyDeps, "renderReminder" | "renderDigest">> = {},
): Promise<Core> {
  const logger = silentLogger();
  const opened = await openHarness(testConfig(temp.dir), {
    models: fauxModels().models,
    extensions: [
      createNotifyExtension({
        sender,
        repos: fixture.repos,
        renderReminder,
        renderDigest,
        ...overrides,
        logger,
      }),
    ],
    logger,
    now: fixture.clock.now,
    setTimer: fixture.clock.setTimer,
  });
  core = opened;
  return opened;
}

// ---------------------------------------------------------------------------
// Task-record helpers (the "fake clock" assertions)
// ---------------------------------------------------------------------------

interface Parked {
  readonly checkpoint: NotifyState;
  readonly until: number;
}

function parked(record: { state: { status: string; checkpoint?: unknown; until?: number } } | undefined): Parked | null {
  const state = record?.state;
  if (state === undefined || state.status !== "sleeping" || state.until === undefined) return null;
  return { checkpoint: state.checkpoint as NotifyState, until: state.until };
}

async function sleepState(opened: Core, id: TaskId<never>, where: (checkpoint: NotifyState) => boolean): Promise<Parked> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await opened.harness.getTask(id, BACKGROUND_CONTEXT);
    const state = parked(record);
    if (state !== null && where(state.checkpoint)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the notify task did not park in the expected sleep");
}

/** Wait for the first schedule (no firing yet): proves the task sleeps at the settings' time. */
async function firstSleep(opened: Core, id: TaskId<never>): Promise<Parked> {
  return sleepState(opened, id, (checkpoint) => checkpoint.phase === "fire" && checkpoint.last === null);
}

/**
 * Advance the fake clock to `target` and wait until the task has fired (`checkpoint.last` exists) and
 * parked again. Newly armed timers may appear only after the wake's async work settles, so the target
 * is re-applied on every poll iteration.
 */
async function fireAt(opened: Core, clock: FakeClock, id: TaskId<never>, target: Date): Promise<NotifyFireResult> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    clock.advanceTo(target);
    const record = await opened.harness.getTask(id, BACKGROUND_CONTEXT);
    const state = parked(record);
    const last = state?.checkpoint.last ?? null;
    if (last !== null) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the notify task did not fire");
}

interface Started {
  readonly reminderId: TaskId<never>;
  readonly digestId: TaskId<never>;
}

async function start(opened: Core): Promise<Started> {
  const ids = await createNotifyScheduler(opened).ensureScheduled();
  return {
    reminderId: Number(ids.reminderTaskId) as TaskId<never>,
    digestId: Number(ids.digestTaskId) as TaskId<never>,
  };
}

// ---------------------------------------------------------------------------
// Pure scheduling math
// ---------------------------------------------------------------------------

describe("nextRunAt", () => {
  it("picks today while the wall-clock time is still ahead", () => {
    expect(nextRunAt("19:00", START)).toEqual(atLocalTime(START, "19:00"));
  });

  it("picks tomorrow once the time has passed", () => {
    const evening = atLocalTime(START, "22:15");
    expect(nextRunAt("19:00", evening)).toEqual(atLocalTime(addLocalDays(evening, 1), "19:00"));
  });

  it("picks tomorrow at exactly the wall-clock time (a wake must not re-fire the same minute)", () => {
    const at = atLocalTime(START, "19:00");
    expect(nextRunAt("19:00", at)).toEqual(atLocalTime(addLocalDays(at, 1), "19:00"));
  });
});

// ---------------------------------------------------------------------------
// Reminder
// ---------------------------------------------------------------------------

describe("hmwrk.reminder", () => {
  it("sleeps until reminder_time, sends the due list and re-schedules for tomorrow", async () => {
    const fixture = household();
    await bindChats(fixture.repos, {});
    await seedDueAssignment(fixture.repos, fixture.clock);
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);
    const { reminderId } = await start(opened);

    // Default settings: reminder_time 19:00 today (12:00 now).
    const waiting = await firstSleep(opened, reminderId);
    expect(waiting.until).toBe(atLocalTime(START, "19:00").getTime());
    expect(telegram.sent).toHaveLength(0);

    const result = await fireAt(opened, fixture.clock, reminderId, atLocalTime(START, "19:00"));

    expect(result).toMatchObject({ kind: "reminder", status: "sent", reason: null, recipients: 1, entries: 1 });
    expect(telegram.sent).toEqual([{ chatId: "chat-child", text: "напоминание: Математика" }]);

    // Next firing: tomorrow at the same wall-clock time — the task is still alive, asleep.
    const next = await sleepState(opened, reminderId, (checkpoint) => checkpoint.phase === "fire" && checkpoint.last !== null);
    expect(next.until).toBe(atLocalTime(addLocalDays(START, 1), "19:00").getTime());
    expect(next.checkpoint.last?.status).toBe("sent");
  });

  it("re-reads reminder_time on every schedule, so a changed time applies after the next firing", async () => {
    const fixture = household();
    await bindChats(fixture.repos, {});
    await seedDueAssignment(fixture.repos, fixture.clock);
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);
    const { reminderId } = await start(opened);
    await firstSleep(opened, reminderId);

    await fixture.repos.settings.set("reminder_time", "08:00");
    await fireAt(opened, fixture.clock, reminderId, atLocalTime(START, "19:00"));

    const next = await sleepState(opened, reminderId, (checkpoint) => checkpoint.phase === "fire" && checkpoint.last !== null);
    expect(next.until).toBe(atLocalTime(addLocalDays(START, 1), "08:00").getTime());
  });

  it("is muted by paused_until and keeps the schedule for tomorrow", async () => {
    const fixture = household({ settings: { paused_until: formatIsoDate(START) } });
    await bindChats(fixture.repos, {});
    await seedDueAssignment(fixture.repos, fixture.clock);
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);
    const { reminderId } = await start(opened);
    await firstSleep(opened, reminderId);

    const result = await fireAt(opened, fixture.clock, reminderId, atLocalTime(START, "19:00"));

    expect(result).toMatchObject({ status: "skipped", reason: "paused" });
    expect(telegram.sent).toHaveLength(0);
    const next = await sleepState(opened, reminderId, (checkpoint) => checkpoint.last !== null);
    expect(next.until).toBe(atLocalTime(addLocalDays(START, 1), "19:00").getTime());
  });

  it("skips without failing when no child chat is bound", async () => {
    const fixture = household();
    await bindChats(fixture.repos, { childChat: null });
    await seedDueAssignment(fixture.repos, fixture.clock);
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);
    const { reminderId } = await start(opened);
    await firstSleep(opened, reminderId);

    const result = await fireAt(opened, fixture.clock, reminderId, atLocalTime(START, "19:00"));

    expect(result).toMatchObject({ status: "skipped", reason: "no_binding", entries: 1 });
    expect(telegram.sent).toHaveLength(0);
    // Still scheduled: the missing binding is a configuration problem, not a task failure.
    const next = await sleepState(opened, reminderId, (checkpoint) => checkpoint.last !== null);
    expect(next.until).toBe(atLocalTime(addLocalDays(START, 1), "19:00").getTime());
  });

  it("records a failed delivery instead of retrying or faulting the task", async () => {
    const fixture = household();
    await bindChats(fixture.repos, {});
    await seedDueAssignment(fixture.repos, fixture.clock);
    const telegram = fakeSender({ fail: true });
    const opened = await openCore(fixture, telegram.sender);
    const { reminderId } = await start(opened);
    await firstSleep(opened, reminderId);

    const result = await fireAt(opened, fixture.clock, reminderId, atLocalTime(START, "19:00"));

    expect(result).toMatchObject({ status: "skipped", reason: "send_failed" });
    const next = await sleepState(opened, reminderId, (checkpoint) => checkpoint.last !== null);
    expect(next.until).toBe(atLocalTime(addLocalDays(START, 1), "19:00").getTime());
  });

  it("skips an empty reminder list", async () => {
    const fixture = household();
    await bindChats(fixture.repos, {});
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);
    const { reminderId } = await start(opened);
    await firstSleep(opened, reminderId);

    const result = await fireAt(opened, fixture.clock, reminderId, atLocalTime(START, "19:00"));

    expect(result).toMatchObject({ status: "skipped", reason: "empty" });
    expect(telegram.sent).toHaveLength(0);
  });

  it("covers the next 24 hours only: an assignment due tomorrow evening is not in tonight's list", async () => {
    const fixture = household();
    await bindChats(fixture.repos, {});
    // SPEC §5.6 window: [now, now + 24h]. Due tomorrow 20:00 is 32 h away from noon, so tonight's
    // reminder stays silent and the child hears about it at tomorrow's 19:00 firing instead.
    await seedDueAssignment(fixture.repos, fixture.clock, {
      due: atLocalTime(addLocalDays(START, 1), "20:00"),
    });
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);
    const { reminderId } = await start(opened);
    await firstSleep(opened, reminderId);

    const result = await fireAt(opened, fixture.clock, reminderId, atLocalTime(START, "19:00"));

    expect(result).toMatchObject({ status: "skipped", reason: "empty" });
    expect(telegram.sent).toHaveLength(0);
  });

  it("leaves an already reported assignment out of the reminder", async () => {
    const fixture = household();
    await bindChats(fixture.repos, {});
    await seedDueAssignment(fixture.repos, fixture.clock, { checkIn: true });
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);
    const { reminderId } = await start(opened);
    await firstSleep(opened, reminderId);

    const result = await fireAt(opened, fixture.clock, reminderId, atLocalTime(START, "19:00"));

    expect(result).toMatchObject({ status: "skipped", reason: "empty" });
  });
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

describe("hmwrk.digest", () => {
  it("collects the four sections, sends to the parent chat and re-schedules for tomorrow", async () => {
    const fixture = household();
    const { childId } = await bindChats(fixture.repos, {});
    // Submitted today (with a draft verdict waiting for the parent).
    const submitted = await seedDueAssignment(fixture.repos, fixture.clock, { checkIn: true, childId });
    const checkIn = await fixture.repos.checkIns.latestForAssignment(submitted.id);
    if (checkIn === null) throw new Error("check-in missing");
    await fixture.repos.verifications.createDraft({
      checkin_id: checkIn.id,
      summary: "№ 12 верно",
      model: "verify-fake",
      findings: [],
    });
    // `submit_check_in` moves the assignment to `in_review`; only stored status is the repo's job.
    await fixture.repos.assignments.setStatus(submitted.id, "in_review");
    // Overdue and never reported.
    await seedDueAssignment(fixture.repos, fixture.clock, {
      due: atLocalTime(addLocalDays(START, -2), "20:00"),
    });
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);
    const { digestId } = await start(opened);

    const waiting = await firstSleep(opened, digestId);
    expect(waiting.until).toBe(atLocalTime(START, "21:00").getTime());

    const result = await fireAt(opened, fixture.clock, digestId, atLocalTime(START, "21:00"));

    expect(result).toMatchObject({ kind: "digest", status: "sent", recipients: 1, entries: 3 });
    expect(telegram.sent).toEqual([{ chatId: "chat-parent", text: "дайджест сдано:1 просрочено:1 ждут:1 парсер:0" }]);
    const next = await sleepState(opened, digestId, (checkpoint) => checkpoint.last !== null);
    expect(next.until).toBe(atLocalTime(addLocalDays(START, 1), "21:00").getTime());
  });

  it("skips an empty digest without calling the renderer", async () => {
    const fixture = household();
    await bindChats(fixture.repos, {});
    const telegram = fakeSender();
    let renders = 0;
    const opened = await openCore(fixture, telegram.sender, {
      renderDigest: (sections) => {
        renders += 1;
        return renderDigest(sections);
      },
    });
    const { digestId } = await start(opened);
    await firstSleep(opened, digestId);

    const result = await fireAt(opened, fixture.clock, digestId, atLocalTime(START, "21:00"));

    expect(result).toMatchObject({ status: "skipped", reason: "empty", entries: 0 });
    expect(renders).toBe(0);
    expect(telegram.sent).toHaveLength(0);
  });

  it("records an unexpected renderer error and keeps the schedule", async () => {
    const fixture = household();
    await bindChats(fixture.repos, {});
    await seedDueAssignment(fixture.repos, fixture.clock);
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender, {
      renderDigest: () => {
        throw new Error("template bug");
      },
      renderReminder: () => {
        throw new Error("template bug");
      },
    });
    const { reminderId } = await start(opened);
    await firstSleep(opened, reminderId);

    const result = await fireAt(opened, fixture.clock, reminderId, atLocalTime(START, "19:00"));

    expect(result).toMatchObject({ status: "skipped", reason: "error" });
    expect(telegram.sent).toHaveLength(0);
    const next = await sleepState(opened, reminderId, (checkpoint) => checkpoint.last !== null);
    expect(next.until).toBe(atLocalTime(addLocalDays(START, 1), "19:00").getTime());
  });

  it("is muted by paused_until as well", async () => {
    const fixture = household({ settings: { paused_until: formatIsoDate(START) } });
    await bindChats(fixture.repos, {});
    await seedDueAssignment(fixture.repos, fixture.clock, {
      due: atLocalTime(addLocalDays(START, -2), "20:00"),
    });
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);
    const { digestId } = await start(opened);
    await firstSleep(opened, digestId);

    const result = await fireAt(opened, fixture.clock, digestId, atLocalTime(START, "21:00"));

    expect(result).toMatchObject({ status: "skipped", reason: "paused" });
    expect(telegram.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

describe("createNotifyScheduler", () => {
  it("creates both tasks once and returns the live ids on a second boot", async () => {
    const fixture = household();
    await bindChats(fixture.repos, {});
    const telegram = fakeSender();
    const opened = await openCore(fixture, telegram.sender);

    const first = await createNotifyScheduler(opened).ensureScheduled();
    await firstSleep(opened, Number(first.reminderTaskId) as TaskId<never>);
    const second = await createNotifyScheduler(opened).ensureScheduled();

    expect(second).toEqual(first);
    expect(first.reminderTaskId).not.toBe(first.digestTaskId);
  });
});
