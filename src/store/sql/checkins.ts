/**
 * `CheckInsRepo` over SQLite (SPEC §5.2 `checkins`, §5.4).
 *
 * Mirrors `InMemoryCheckInsRepo` (ordering `created_at ASC, rowid ASC`, `touch()` bumps `updated_at`).
 * Rows are not validated against `assignments`/`users` — the T1 fakes do not validate either, and the
 * agent tools own that check.
 */

import { NotFoundError } from "../../domain/errors.js";
import type { CheckInFilter, CheckInsRepo, NewCheckInInput } from "../../domain/repo.js";
import type { CheckIn, DateInput, Id, IsoDateTime } from "../../domain/types.js";
import { paginate, storedInstant, type SqliteContext } from "./context.js";

const CHECKIN_COLUMNS = "id, assignment_id, child_user_id, comment, created_at, updated_at";

interface CheckInRow {
  id: string;
  assignment_id: string;
  child_user_id: string;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

function toCheckIn(row: CheckInRow): CheckIn {
  return {
    id: row.id,
    assignment_id: row.assignment_id,
    child_user_id: row.child_user_id,
    comment: row.comment,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SqliteCheckInsRepo implements CheckInsRepo {
  constructor(private readonly ctx: SqliteContext) {}

  private get db() {
    return this.ctx.db;
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
    await this.db.run(
      `INSERT INTO checkins (id, assignment_id, child_user_id, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      checkIn.id,
      checkIn.assignment_id,
      checkIn.child_user_id,
      checkIn.comment,
      checkIn.created_at,
      checkIn.updated_at,
    );
    return checkIn;
  }

  async get(id: Id): Promise<CheckIn | null> {
    const row = await this.db.get<CheckInRow>(
      `SELECT ${CHECKIN_COLUMNS} FROM checkins WHERE id = ?`,
      id,
    );
    return row === undefined ? null : toCheckIn(row);
  }

  async listByAssignment(assignmentId: Id): Promise<CheckIn[]> {
    const rows = await this.db.all<CheckInRow>(
      `SELECT ${CHECKIN_COLUMNS} FROM checkins
       WHERE assignment_id = ?
       ORDER BY created_at ASC, rowid ASC`,
      assignmentId,
    );
    return rows.map(toCheckIn);
  }

  async latestForAssignment(assignmentId: Id): Promise<CheckIn | null> {
    const row = await this.db.get<CheckInRow>(
      `SELECT ${CHECKIN_COLUMNS} FROM checkins
       WHERE assignment_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      assignmentId,
    );
    return row === undefined ? null : toCheckIn(row);
  }

  async listForChild(
    childUserId: Id,
    filter: Omit<CheckInFilter, "childUserId"> = {},
  ): Promise<CheckIn[]> {
    const conditions = ["child_user_id = ?"];
    const params: (string | number)[] = [childUserId];
    if (filter.since !== undefined) {
      conditions.push("created_at >= ?");
      params.push(storedInstant(filter.since));
    }
    if (filter.until !== undefined) {
      conditions.push("created_at < ?");
      params.push(storedInstant(filter.until));
    }
    const limit = paginate(filter.limit, undefined);
    const rows = await this.db.all<CheckInRow>(
      `SELECT ${CHECKIN_COLUMNS} FROM checkins
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at ASC, rowid ASC${limit.sql}`,
      ...params,
      ...limit.params,
    );
    return rows.map(toCheckIn);
  }

  async listSince(since: DateInput): Promise<CheckIn[]> {
    const rows = await this.db.all<CheckInRow>(
      `SELECT ${CHECKIN_COLUMNS} FROM checkins
       WHERE created_at >= ?
       ORDER BY created_at ASC, rowid ASC`,
      storedInstant(since),
    );
    return rows.map(toCheckIn);
  }

  async touch(id: Id): Promise<CheckIn> {
    const updatedAt: IsoDateTime = this.ctx.timestamp();
    const changed = await this.db.runCounted(
      `UPDATE checkins SET updated_at = ? WHERE id = ?`,
      updatedAt,
      id,
    );
    if (changed === 0) throw new NotFoundError(`Check-in ${id} not found`);
    const checkIn = await this.get(id);
    if (checkIn === null) throw new NotFoundError(`Check-in ${id} not found`);
    return checkIn;
  }
}
