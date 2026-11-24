/**
 * In-memory implementations of the repository contracts (`./repo.ts`).
 *
 * Used by:
 * - unit tests of the domain layer,
 * - A2 (agent tools), V2 (verify pipeline) and N1 (reminder/digest) in their own tests,
 * - any harness that needs the domain without a database.
 *
 * Semantics deliberately mirror what D2 must implement: repositories generate ids and
 * timestamps, return copies, never throw on lookups, and enforce the status machines from
 * `./status.ts` on writes. Everything lives in one {@link MemoryStore}, so cross-repository
 * lookups (assignment → check-in → verification) work without wiring.
 */

import { asDate, toIso } from "./dates.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { parseSettingValue } from "./schemas.js";
import { resolveSettings } from "./settings.js";
import { applyVerificationAction } from "./status.js";
import { newId as defaultNewId } from "./types.js";
import type {
  Assignment,
  AssignmentItem,
  AssignmentStatus,
  AssignmentWithItems,
  CheckIn,
  CheckInWithPhotos,
  DateInput,
  Id,
  IsoDateTime,
  Photo,
  PhotoKind,
  Role,
  Settings,
  SettingKey,
  TgBinding,
  User,
  Verification,
  VerificationFinding,
  VerificationWithFindings,
} from "./types.js";
import type {
  AssignmentFilter,
  AssignmentsRepo,
  CheckInFilter,
  CheckInsRepo,
  NewAssignmentInput,
  NewAssignmentItemInput,
  NewCheckInInput,
  NewPhotoInput,
  NewUserInput,
  NewVerificationInput,
  PhotosRepo,
  Repos,
  SettingsRepo,
  TgBindingInput,
  TgBindingsRepo,
  UsersRepo,
  VerificationFilter,
  VerificationListFilter,
  VerificationsRepo,
} from "./repo.js";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Mutable state behind every fake repository. */
export interface MemoryStore {
  users: User[];
  assignments: Assignment[];
  items: AssignmentItem[];
  checkIns: CheckIn[];
  photos: Photo[];
  checkinPhotos: { checkin_id: Id; photo_id: Id }[];
  verifications: Verification[];
  findings: VerificationFinding[];
  tgBindings: TgBinding[];
  /** Stored overrides only; defaults come from `./settings.ts`. */
  settings: Partial<Settings>;
}

/** Options shared by the fake repositories. */
export interface MemoryOptions {
  /** Clock; defaults to the real one. Tests freeze it for deterministic timestamps. */
  now?: () => Date;
  /** ID factory; defaults to uuid v4. */
  newId?: () => Id;
  /** Initial stored settings overrides. */
  settings?: Partial<Settings>;
  /** Reuse an existing store (or create one with {@link createMemoryStore}). */
  store?: MemoryStore;
}

/** Empty store. */
export function createMemoryStore(): MemoryStore {
  return {
    users: [],
    assignments: [],
    items: [],
    checkIns: [],
    photos: [],
    checkinPhotos: [],
    verifications: [],
    findings: [],
    tgBindings: [],
    settings: {},
  };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

function sortByIso<T>(rows: readonly T[], pick: (row: T) => IsoDateTime): T[] {
  return [...rows].sort((a, b) => asDate(pick(a)).getTime() - asDate(pick(b)).getTime());
}

/** Shared clock/id context handed to every fake. */
class Context {
  constructor(
    readonly store: MemoryStore,
    readonly clock: () => Date,
    readonly ids: () => Id,
  ) {}

  now(): Date {
    return this.clock();
  }

  timestamp(): IsoDateTime {
    return toIso(this.clock());
  }

  id(): Id {
    return this.ids();
  }
}

function contextOf(options: MemoryOptions = {}): Context {
  const store = options.store ?? createMemoryStore();
  if (options.settings) {
    const overrides = store.settings as Record<string, unknown>;
    for (const [key, value] of Object.entries(options.settings)) {
      overrides[key] = value;
    }
  }
  return new Context(store, options.now ?? (() => new Date()), options.newId ?? defaultNewId);
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

function matchesAssignment(assignment: Assignment, filter: AssignmentFilter, store: MemoryStore): boolean {
  if (filter.hasCheckIn !== undefined) {
    const hasCheckIn = store.checkIns.some((checkIn) => checkIn.assignment_id === assignment.id);
    if (hasCheckIn !== filter.hasCheckIn) return false;
  }
  if (filter.status !== undefined) {
    const statuses = toArray(filter.status);
    if (!statuses.includes(assignment.status)) return false;
  }
  if (filter.subject !== undefined) {
    if (assignment.subject.trim().toLowerCase() !== filter.subject.trim().toLowerCase()) return false;
  }
  if (filter.dueBefore !== undefined) {
    if (!(asDate(assignment.due_at).getTime() < asDate(filter.dueBefore).getTime())) return false;
  }
  if (filter.dueAfter !== undefined) {
    if (!(asDate(assignment.due_at).getTime() >= asDate(filter.dueAfter).getTime())) return false;
  }
  return true;
}

function byDue<T extends { due_at: IsoDateTime; created_at: IsoDateTime }>(a: T, b: T): number {
  const byDueAt = asDate(a.due_at).getTime() - asDate(b.due_at).getTime();
  if (byDueAt !== 0) return byDueAt;
  return asDate(a.created_at).getTime() - asDate(b.created_at).getTime();
}

export class InMemoryAssignmentsRepo implements AssignmentsRepo {
  constructor(private readonly ctx: Context) {}

  private find(id: Id): Assignment | undefined {
    return this.ctx.store.assignments.find((a) => a.id === id);
  }

  private require(id: Id): Assignment {
    const assignment = this.find(id);
    if (!assignment) throw new NotFoundError(`Assignment ${id} not found`);
    return assignment;
  }

  private itemsOf(assignmentId: Id): AssignmentItem[] {
    return this.ctx.store.items
      .filter((item) => item.assignment_id === assignmentId)
      .sort((a, b) => a.position - b.position || asDate(a.created_at).getTime() - asDate(b.created_at).getTime())
      .map(copy);
  }

  private withItems(assignment: Assignment): AssignmentWithItems {
    return { ...copy(assignment), items: this.itemsOf(assignment.id) };
  }

  async create(input: NewAssignmentInput): Promise<AssignmentWithItems> {
    const now = this.ctx.timestamp();
    const assignment: Assignment = {
      id: this.ctx.id(),
      subject: input.subject,
      due_at: input.due_at,
      source: input.source,
      status: "active",
      note: input.note ?? null,
      created_at: now,
      updated_at: now,
    };
    this.ctx.store.assignments.push(assignment);
    if (input.items && input.items.length > 0) {
      await this.addItems(assignment.id, input.items);
      assignment.updated_at = now;
    }
    return this.withItems(assignment);
  }

  async get(id: Id): Promise<Assignment | null> {
    const assignment = this.find(id);
    return assignment ? copy(assignment) : null;
  }

  async getWithItems(id: Id): Promise<AssignmentWithItems | null> {
    const assignment = this.find(id);
    return assignment ? this.withItems(assignment) : null;
  }

  async list(filter: AssignmentFilter = {}): Promise<Assignment[]> {
    const rows = this.ctx.store.assignments
      .filter((assignment) => matchesAssignment(assignment, filter, this.ctx.store))
      .sort(byDue)
      .map(copy);
    const offset = filter.offset ?? 0;
    const sliced = offset > 0 ? rows.slice(offset) : rows;
    return filter.limit === undefined ? sliced : sliced.slice(0, filter.limit);
  }

  async listWithItems(filter: AssignmentFilter = {}): Promise<AssignmentWithItems[]> {
    const rows = await this.list(filter);
    return rows.map((assignment) => ({ ...assignment, items: this.itemsOf(assignment.id) }));
  }

  async listActive(): Promise<Assignment[]> {
    return this.list({ status: "active" });
  }

  async listOverdue(now: DateInput): Promise<Assignment[]> {
    const instant = asDate(now).getTime();
    return this.ctx.store.assignments
      .filter((assignment) => assignment.status === "active" && asDate(assignment.due_at).getTime() < instant)
      .sort(byDue)
      .map(copy);
  }

  async listDueWithin(from: DateInput, to: DateInput): Promise<Assignment[]> {
    const start = asDate(from).getTime();
    const end = asDate(to).getTime();
    return this.ctx.store.assignments
      .filter((assignment) => {
        if (assignment.status !== "active") return false;
        const due = asDate(assignment.due_at).getTime();
        return due >= start && due < end;
      })
      .sort(byDue)
      .map(copy);
  }

  async listItems(assignmentId: Id): Promise<AssignmentItem[]> {
    return this.itemsOf(assignmentId);
  }

  async getItem(id: Id): Promise<AssignmentItem | null> {
    const item = this.ctx.store.items.find((candidate) => candidate.id === id);
    return item ? copy(item) : null;
  }

  async addItems(assignmentId: Id, items: readonly NewAssignmentItemInput[]): Promise<AssignmentItem[]> {
    const assignment = this.require(assignmentId);
    const existing = this.ctx.store.items.filter((item) => item.assignment_id === assignmentId);
    const nextPosition = existing.reduce((max, item) => Math.max(max, item.position + 1), 0);
    const now = this.ctx.timestamp();
    const created = items.map((input, index) => {
      const item: AssignmentItem = {
        id: this.ctx.id(),
        assignment_id: assignmentId,
        label: input.label,
        note: input.note ?? null,
        position: input.position ?? nextPosition + index,
        created_at: now,
      };
      this.ctx.store.items.push(item);
      return copy(item);
    });
    assignment.updated_at = now;
    return created;
  }

  async setStatus(id: Id, status: AssignmentStatus): Promise<Assignment> {
    const assignment = this.require(id);
    assignment.status = status;
    assignment.updated_at = this.ctx.timestamp();
    return copy(assignment);
  }
}

// ---------------------------------------------------------------------------
// Check-ins
// ---------------------------------------------------------------------------

export class InMemoryCheckInsRepo implements CheckInsRepo {
  constructor(private readonly ctx: Context) {}

  private require(id: Id): CheckIn {
    const checkIn = this.ctx.store.checkIns.find((candidate) => candidate.id === id);
    if (!checkIn) throw new NotFoundError(`Check-in ${id} not found`);
    return checkIn;
  }

  private matching(filter: CheckInFilter): CheckIn[] {
    return this.ctx.store.checkIns.filter((checkIn) => {
      if (filter.childUserId !== undefined && checkIn.child_user_id !== filter.childUserId) return false;
      if (filter.since !== undefined && asDate(checkIn.created_at).getTime() < asDate(filter.since).getTime()) return false;
      if (filter.until !== undefined && asDate(checkIn.created_at).getTime() >= asDate(filter.until).getTime()) return false;
      return true;
    });
  }

  async create(input: NewCheckInInput): Promise<CheckIn> {
    const now = this.ctx.timestamp();
    const checkIn: CheckIn = {
      id: this.ctx.id(),
      assignment_id: input.assignment_id,
      child_user_id: input.child_user_id,
      comment: input.comment ?? null,
      created_at: now,
      updated_at: now,
    };
    this.ctx.store.checkIns.push(checkIn);
    return copy(checkIn);
  }

  async get(id: Id): Promise<CheckIn | null> {
    const checkIn = this.ctx.store.checkIns.find((candidate) => candidate.id === id);
    return checkIn ? copy(checkIn) : null;
  }

  async listByAssignment(assignmentId: Id): Promise<CheckIn[]> {
    return sortByIso(
      this.ctx.store.checkIns.filter((checkIn) => checkIn.assignment_id === assignmentId),
      (checkIn) => checkIn.created_at,
    ).map(copy);
  }

  async latestForAssignment(assignmentId: Id): Promise<CheckIn | null> {
    const rows = await this.listByAssignment(assignmentId);
    return rows.length > 0 ? (rows[rows.length - 1] ?? null) : null;
  }

  async listForChild(childUserId: Id, filter: Omit<CheckInFilter, "childUserId"> = {}): Promise<CheckIn[]> {
    const rows = this.matching({ ...filter, childUserId });
    const sorted = sortByIso(rows, (checkIn) => checkIn.created_at);
    const limited = filter.limit === undefined ? sorted : sorted.slice(0, filter.limit);
    return limited.map(copy);
  }

  async listSince(since: DateInput): Promise<CheckIn[]> {
    return sortByIso(this.matching({ since: toIso(asDate(since)) }), (checkIn) => checkIn.created_at).map(copy);
  }

  async touch(id: Id): Promise<CheckIn> {
    const checkIn = this.require(id);
    checkIn.updated_at = this.ctx.timestamp();
    return copy(checkIn);
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export class InMemoryPhotosRepo implements PhotosRepo {
  constructor(private readonly ctx: Context) {}

  private requirePhoto(id: Id): Photo {
    const photo = this.ctx.store.photos.find((candidate) => candidate.id === id);
    if (!photo) throw new NotFoundError(`Photo ${id} not found`);
    return photo;
  }

  private requireCheckIn(id: Id): CheckIn {
    const checkIn = this.ctx.store.checkIns.find((candidate) => candidate.id === id);
    if (!checkIn) throw new NotFoundError(`Check-in ${id} not found`);
    return checkIn;
  }

  async create(input: NewPhotoInput): Promise<Photo> {
    const photo: Photo = {
      id: this.ctx.id(),
      kind: input.kind,
      path: input.path,
      mime: input.mime,
      created_at: this.ctx.timestamp(),
    };
    this.ctx.store.photos.push(photo);
    return copy(photo);
  }

  async get(id: Id): Promise<Photo | null> {
    const photo = this.ctx.store.photos.find((candidate) => candidate.id === id);
    return photo ? copy(photo) : null;
  }

  async listByCheckIn(checkinId: Id): Promise<Photo[]> {
    const ids = new Set(
      this.ctx.store.checkinPhotos.filter((link) => link.checkin_id === checkinId).map((link) => link.photo_id),
    );
    return sortByIso(
      this.ctx.store.photos.filter((photo) => ids.has(photo.id)),
      (photo) => photo.created_at,
    ).map(copy);
  }

  async listByKind(kind: PhotoKind): Promise<Photo[]> {
    return sortByIso(
      this.ctx.store.photos.filter((photo) => photo.kind === kind),
      (photo) => photo.created_at,
    ).map(copy);
  }

  async attachToCheckIn(checkinId: Id, photoId: Id): Promise<void> {
    this.requireCheckIn(checkinId);
    this.requirePhoto(photoId);
    const exists = this.ctx.store.checkinPhotos.some(
      (link) => link.checkin_id === checkinId && link.photo_id === photoId,
    );
    if (exists) return;
    this.ctx.store.checkinPhotos.push({ checkin_id: checkinId, photo_id: photoId });
  }

  async detachFromCheckIn(checkinId: Id, photoId: Id): Promise<void> {
    this.ctx.store.checkinPhotos = this.ctx.store.checkinPhotos.filter(
      (link) => !(link.checkin_id === checkinId && link.photo_id === photoId),
    );
  }

  async listCheckInIds(photoId: Id): Promise<Id[]> {
    return this.ctx.store.checkinPhotos
      .filter((link) => link.photo_id === photoId)
      .map((link) => link.checkin_id);
  }
}

// ---------------------------------------------------------------------------
// Verifications
// ---------------------------------------------------------------------------

export class InMemoryVerificationsRepo implements VerificationsRepo {
  constructor(private readonly ctx: Context) {}

  private require(id: Id): Verification {
    const verification = this.ctx.store.verifications.find((candidate) => candidate.id === id);
    if (!verification) throw new NotFoundError(`Verification ${id} not found`);
    return verification;
  }

  private findingsOf(verificationId: Id): VerificationFinding[] {
    return this.ctx.store.findings.filter((finding) => finding.verification_id === verificationId).map(copy);
  }

  private withFindings(verification: Verification): VerificationWithFindings {
    return { ...copy(verification), findings: this.findingsOf(verification.id) };
  }

  private statusesOf(filter: VerificationFilter = {}): Verification["status"][] | null {
    if (filter.status === undefined) return null;
    return toArray(filter.status);
  }

  private checkInIdsOfAssignment(assignmentId: Id): Set<Id> {
    return new Set(
      this.ctx.store.checkIns.filter((checkIn) => checkIn.assignment_id === assignmentId).map((checkIn) => checkIn.id),
    );
  }

  async createDraft(input: NewVerificationInput): Promise<VerificationWithFindings> {
    const verification: Verification = {
      id: this.ctx.id(),
      checkin_id: input.checkin_id,
      status: "draft",
      summary: input.summary,
      model: input.model,
      created_at: this.ctx.timestamp(),
      decided_at: null,
      decided_by_user_id: null,
    };
    this.ctx.store.verifications.push(verification);
    for (const finding of input.findings) {
      this.ctx.store.findings.push({
        verification_id: verification.id,
        item_id: finding.item_id,
        verdict: finding.verdict,
        comment: finding.comment ?? null,
      });
    }
    return this.withFindings(verification);
  }

  async get(id: Id): Promise<Verification | null> {
    const verification = this.ctx.store.verifications.find((candidate) => candidate.id === id);
    return verification ? copy(verification) : null;
  }

  async getWithFindings(id: Id): Promise<VerificationWithFindings | null> {
    const verification = this.ctx.store.verifications.find((candidate) => candidate.id === id);
    return verification ? this.withFindings(verification) : null;
  }

  async listByCheckIn(checkinId: Id): Promise<Verification[]> {
    return sortByIso(
      this.ctx.store.verifications.filter((verification) => verification.checkin_id === checkinId),
      (verification) => verification.created_at,
    ).map(copy);
  }

  async list(filter: VerificationListFilter = {}): Promise<Verification[]> {
    const statuses = this.statusesOf(filter);
    const sorted = sortByIso(
      this.ctx.store.verifications.filter(
        (verification) =>
          (filter.checkinId === undefined || verification.checkin_id === filter.checkinId) &&
          (statuses === null || statuses.includes(verification.status)),
      ),
      (verification) => verification.created_at,
    );
    const limited = filter.limit === undefined ? sorted : sorted.slice(0, filter.limit);
    return limited.map(copy);
  }

  async listByAssignment(assignmentId: Id, filter: VerificationFilter = {}): Promise<Verification[]> {
    const checkInIds = this.checkInIdsOfAssignment(assignmentId);
    const statuses = this.statusesOf(filter);
    return sortByIso(
      this.ctx.store.verifications.filter(
        (verification) =>
          checkInIds.has(verification.checkin_id) && (statuses === null || statuses.includes(verification.status)),
      ),
      (verification) => verification.created_at,
    ).map(copy);
  }

  async latestForCheckIn(checkinId: Id): Promise<VerificationWithFindings | null> {
    const rows = await this.listByCheckIn(checkinId);
    const latest = rows[rows.length - 1];
    return latest ? this.withFindings(latest) : null;
  }

  async latestDraftForCheckIn(checkinId: Id): Promise<VerificationWithFindings | null> {
    const latest = await this.latestForCheckIn(checkinId);
    return latest && latest.status === "draft" ? latest : null;
  }

  async listDrafts(): Promise<Verification[]> {
    return sortByIso(
      this.ctx.store.verifications.filter((verification) => verification.status === "draft"),
      (verification) => verification.created_at,
    ).map(copy);
  }

  async listPending(): Promise<Verification[]> {
    const latestDraftByCheckIn = new Map<Id, Verification>();
    for (const verification of sortByIso(this.ctx.store.verifications, (row) => row.created_at)) {
      if (verification.status === "draft") latestDraftByCheckIn.set(verification.checkin_id, verification);
      else latestDraftByCheckIn.delete(verification.checkin_id);
    }
    return sortByIso(
      [...latestDraftByCheckIn.values()],
      (verification) => verification.created_at,
    ).map(copy);
  }

  async findings(verificationId: Id): Promise<VerificationFinding[]> {
    return this.findingsOf(verificationId);
  }

  async decide(
    id: Id,
    decision: "approved" | "dismissed",
    decidedByUserId: Id | null,
    decidedAt?: DateInput,
  ): Promise<Verification> {
    const verification = this.require(id);
    const next = applyVerificationAction(verification.status, decision === "approved" ? "approve" : "dismiss");
    if (next === verification.status) return copy(verification);
    verification.status = next;
    verification.decided_at = decidedAt === undefined ? this.ctx.timestamp() : toIso(asDate(decidedAt));
    verification.decided_by_user_id = decidedByUserId;
    return copy(verification);
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export class InMemoryUsersRepo implements UsersRepo {
  constructor(private readonly ctx: Context) {}

  private require(id: Id): User {
    const user = this.ctx.store.users.find((candidate) => candidate.id === id);
    if (!user) throw new NotFoundError(`User ${id} not found`);
    return user;
  }

  async create(input: NewUserInput): Promise<User> {
    if (this.ctx.store.users.some((user) => user.openwebui_user_id === input.openwebui_user_id)) {
      throw new ConflictError(`User with OpenWebUI id ${input.openwebui_user_id} already exists`);
    }
    const user: User = {
      id: this.ctx.id(),
      openwebui_user_id: input.openwebui_user_id,
      role: input.role,
      name: input.name,
      created_at: this.ctx.timestamp(),
    };
    this.ctx.store.users.push(user);
    return copy(user);
  }

  async upsert(input: NewUserInput): Promise<User> {
    const existing = this.ctx.store.users.find((user) => user.openwebui_user_id === input.openwebui_user_id);
    if (!existing) return this.create(input);
    existing.role = input.role;
    existing.name = input.name;
    return copy(existing);
  }

  async get(id: Id): Promise<User | null> {
    const user = this.ctx.store.users.find((candidate) => candidate.id === id);
    return user ? copy(user) : null;
  }

  async getByOpenWebUiId(openwebuiUserId: string): Promise<User | null> {
    const user = this.ctx.store.users.find((candidate) => candidate.openwebui_user_id === openwebuiUserId);
    return user ? copy(user) : null;
  }

  async list(): Promise<User[]> {
    return sortByIso(this.ctx.store.users, (user) => user.created_at).map(copy);
  }

  async listByRole(role: Role): Promise<User[]> {
    return (await this.list()).filter((user) => user.role === role);
  }

  async setRole(id: Id, role: Role): Promise<User> {
    const user = this.require(id);
    user.role = role;
    return copy(user);
  }
}

// ---------------------------------------------------------------------------
// Telegram bindings
// ---------------------------------------------------------------------------

export class InMemoryTgBindingsRepo implements TgBindingsRepo {
  constructor(private readonly ctx: Context) {}

  async upsert(input: TgBindingInput): Promise<TgBinding> {
    const existing = this.ctx.store.tgBindings.find((binding) => binding.user_id === input.user_id);
    if (existing) {
      existing.chat_id = input.chat_id;
      return copy(existing);
    }
    const binding: TgBinding = {
      user_id: input.user_id,
      chat_id: input.chat_id,
      created_at: this.ctx.timestamp(),
    };
    this.ctx.store.tgBindings.push(binding);
    return copy(binding);
  }

  async getByUserId(userId: Id): Promise<TgBinding | null> {
    const binding = this.ctx.store.tgBindings.find((candidate) => candidate.user_id === userId);
    return binding ? copy(binding) : null;
  }

  async list(): Promise<TgBinding[]> {
    return sortByIso(this.ctx.store.tgBindings, (binding) => binding.created_at).map(copy);
  }

  async remove(userId: Id): Promise<boolean> {
    const before = this.ctx.store.tgBindings.length;
    this.ctx.store.tgBindings = this.ctx.store.tgBindings.filter((binding) => binding.user_id !== userId);
    return this.ctx.store.tgBindings.length !== before;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export class InMemorySettingsRepo implements SettingsRepo {
  constructor(private readonly ctx: Context) {}

  async getAll(): Promise<Settings> {
    return resolveSettings(this.ctx.store.settings);
  }

  async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
    const settings = await this.getAll();
    return settings[key];
  }

  async set<K extends SettingKey>(key: K, value: Settings[K]): Promise<Settings> {
    const validated = parseSettingValue(key, value);
    this.ctx.store.settings = { ...this.ctx.store.settings, [key]: validated };
    return this.getAll();
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      await this.set(key as SettingKey, value as Settings[SettingKey]);
    }
    return this.getAll();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Bundled in-memory repositories sharing one store. */
export type InMemoryRepos = Repos & {
  store: MemoryStore;
  /** Same store, for direct assertions in tests (read-only by convention). */
  raw: MemoryStore;
};

/**
 * Build all repository fakes over one shared store.
 *
 * ```ts
 * const repos = createInMemoryRepos({ now: () => new Date("2026-11-24T16:00:00Z") });
 * const assignment = await repos.assignments.create({ subject: "Математика", due_at, source: "manual", items: [{ label: "№ 12" }] });
 * ```
 */
export function createInMemoryRepos(options: MemoryOptions = {}): InMemoryRepos {
  const ctx = contextOf(options);
  return {
    users: new InMemoryUsersRepo(ctx),
    assignments: new InMemoryAssignmentsRepo(ctx),
    checkIns: new InMemoryCheckInsRepo(ctx),
    photos: new InMemoryPhotosRepo(ctx),
    verifications: new InMemoryVerificationsRepo(ctx),
    tgBindings: new InMemoryTgBindingsRepo(ctx),
    settings: new InMemorySettingsRepo(ctx),
    store: ctx.store,
    raw: ctx.store,
  };
}

/** Build one fake repository over a store — for mixing fakes with other implementations. */
export function createInMemoryAssignmentsRepo(options: MemoryOptions = {}): InMemoryAssignmentsRepo {
  return new InMemoryAssignmentsRepo(contextOf(options));
}

export function createInMemoryCheckInsRepo(options: MemoryOptions = {}): InMemoryCheckInsRepo {
  return new InMemoryCheckInsRepo(contextOf(options));
}

export function createInMemoryPhotosRepo(options: MemoryOptions = {}): InMemoryPhotosRepo {
  return new InMemoryPhotosRepo(contextOf(options));
}

export function createInMemoryVerificationsRepo(options: MemoryOptions = {}): InMemoryVerificationsRepo {
  return new InMemoryVerificationsRepo(contextOf(options));
}

export function createInMemoryUsersRepo(options: MemoryOptions = {}): InMemoryUsersRepo {
  return new InMemoryUsersRepo(contextOf(options));
}

export function createInMemoryTgBindingsRepo(options: MemoryOptions = {}): InMemoryTgBindingsRepo {
  return new InMemoryTgBindingsRepo(contextOf(options));
}

export function createInMemorySettingsRepo(options: MemoryOptions = {}): InMemorySettingsRepo {
  return new InMemorySettingsRepo(contextOf(options));
}

/** Type helper used by tests: a check-in with its photos, as tools render it. */
export async function loadCheckInWithPhotos(
  repos: Pick<Repos, "checkIns" | "photos">,
  checkinId: Id,
): Promise<CheckInWithPhotos | null> {
  const checkIn = await repos.checkIns.get(checkinId);
  if (!checkIn) return null;
  return { ...checkIn, photos: await repos.photos.listByCheckIn(checkinId) };
}
