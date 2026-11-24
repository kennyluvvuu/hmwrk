/**
 * `AssignmentsRepo` over SQLite (SPEC §5.2 `assignments`, `assignment_items`).
 *
 * Semantics mirror `InMemoryAssignmentsRepo` in `src/domain/fakes.ts` (same ordering, same "missing row →
 * `NotFoundError`", same position bookkeeping); the differences are only where SQL is involved:
 *
 * - ordering is `due_at ASC, created_at ASC, rowid ASC` — `rowid` breaks ties so two rows written in the
 *   same millisecond (a frozen test clock, a fast boot) still come back in insertion order;
 * - `subject` filtering compares `subject_key` (lowercased in JS) instead of SQLite's ASCII-only `LOWER()`,
 *   so «Математика» matches «математика» the way `fakes.ts` does;
 * - `hasCheckIn` is a `[NOT] EXISTS` subquery on `checkins` (the reminder list of SPEC §5.6).
 */

import type { SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { NotFoundError } from "../../domain/errors.js";
import type {
  AssignmentFilter,
  AssignmentsRepo,
  NewAssignmentInput,
  NewAssignmentItemInput,
} from "../../domain/repo.js";
import type {
  Assignment,
  AssignmentItem,
  AssignmentSource,
  AssignmentStatus,
  AssignmentWithItems,
  DateInput,
  Id,
} from "../../domain/types.js";
import { placeholders, paginate, storedInstant, subjectKey, type SqliteContext, type SqliteExecutorContext } from "./context.js";

const ASSIGNMENT_COLUMNS = "id, subject, due_at, source, status, note, created_at, updated_at";
/** Same columns qualified with the `a` alias used by the filtered query. */
const ASSIGNMENT_COLUMNS_A =
  "a.id, a.subject, a.due_at, a.source, a.status, a.note, a.created_at, a.updated_at";
const ITEM_COLUMNS = "id, assignment_id, label, note, position, created_at";

interface AssignmentRow {
  id: string;
  subject: string;
  due_at: string;
  source: string;
  status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  assignment_id: string;
  label: string;
  note: string | null;
  position: number;
  created_at: string;
}

function toAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    subject: row.subject,
    due_at: row.due_at,
    source: row.source as AssignmentSource,
    status: row.status as AssignmentStatus,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toItem(row: ItemRow): AssignmentItem {
  return {
    id: row.id,
    assignment_id: row.assignment_id,
    label: row.label,
    note: row.note,
    position: row.position,
    created_at: row.created_at,
  };
}

function statusesOf(filter: AssignmentFilter): AssignmentStatus[] | null {
  const status = filter.status;
  if (status === undefined) return null;
  return Array.isArray(status) ? [...(status as readonly AssignmentStatus[])] : [status as AssignmentStatus];
}

interface WhereClause {
  readonly sql: string;
  readonly params: SqliteValue[];
}

/** `WHERE …` of {@link SqliteAssignmentsRepo.list}; all conditions are ANDed, like the filter contract. */
function assignmentWhere(filter: AssignmentFilter): WhereClause {
  const conditions: string[] = [];
  const params: SqliteValue[] = [];

  const statuses = statusesOf(filter);
  if (statuses !== null) {
    if (statuses.length === 0) {
      // An empty status set can never match; keep the SQL valid rather than guessing.
      conditions.push("0");
    } else {
      conditions.push(`a.status IN (${placeholders(statuses.length)})`);
      params.push(...statuses);
    }
  }
  if (filter.subject !== undefined) {
    conditions.push("a.subject_key = ?");
    params.push(subjectKey(filter.subject));
  }
  if (filter.dueBefore !== undefined) {
    conditions.push("a.due_at < ?");
    params.push(storedInstant(filter.dueBefore));
  }
  if (filter.dueAfter !== undefined) {
    conditions.push("a.due_at >= ?");
    params.push(storedInstant(filter.dueAfter));
  }
  if (filter.hasCheckIn !== undefined) {
    const exists = "EXISTS (SELECT 1 FROM checkins c WHERE c.assignment_id = a.id)";
    conditions.push(filter.hasCheckIn ? exists : `NOT ${exists}`);
  }

  return {
    sql: conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

export class SqliteAssignmentsRepo implements AssignmentsRepo {
  constructor(private readonly ctx: SqliteContext) {}

  private get db() {
    return this.ctx.db;
  }

  /** Items of one assignment in display order (position, then creation). */
  private async itemsOf(executor: SqliteExecutor, assignmentId: Id): Promise<AssignmentItem[]> {
    const rows = await executor.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM assignment_items WHERE assignment_id = ? ORDER BY position ASC, created_at ASC, rowid ASC`,
      assignmentId,
    );
    return rows.map(toItem);
  }

  private async require(
    executor: SqliteExecutor,
    id: Id,
    entity = "Assignment",
  ): Promise<Assignment> {
    const row = await executor.get<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE id = ?`,
      id,
    );
    if (row === undefined) throw new NotFoundError(`${entity} ${id} not found`);
    return toAssignment(row);
  }

  async create(input: NewAssignmentInput): Promise<AssignmentWithItems> {
    const id = this.ctx.id();
    const now = this.ctx.timestamp();
    const inputs = input.items ?? [];
    return this.db.transaction(async (tx) => {
      const writer = this.ctx.with(tx);
      await tx.run(
        `INSERT INTO assignments (id, subject, subject_key, due_at, source, status, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.subject,
        subjectKey(input.subject),
        storedInstant(input.due_at),
        input.source,
        "active",
        input.note ?? null,
        now,
        now,
      );
      const items = await this.insertItems(writer, id, inputs, 0);
      const assignment = await this.require(tx, id);
      return { ...assignment, items };
    });
  }

  async get(id: Id): Promise<Assignment | null> {
    const row = await this.db.get<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE id = ?`,
      id,
    );
    return row === undefined ? null : toAssignment(row);
  }

  async getWithItems(id: Id): Promise<AssignmentWithItems | null> {
    const assignment = await this.get(id);
    if (assignment === null) return null;
    return { ...assignment, items: await this.itemsOf(this.db, id) };
  }

  async list(filter: AssignmentFilter = {}): Promise<Assignment[]> {
    const where = assignmentWhere(filter);
    const limit = paginate(filter.limit, filter.offset);
    const rows = await this.db.all<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS_A} FROM assignments a${where.sql}
       ORDER BY a.due_at ASC, a.created_at ASC, a.rowid ASC${limit.sql}`,
      ...where.params,
      ...limit.params,
    );
    return rows.map(toAssignment);
  }

  async listWithItems(filter: AssignmentFilter = {}): Promise<AssignmentWithItems[]> {
    const assignments = await this.list(filter);
    if (assignments.length === 0) return [];
    const ids = assignments.map((assignment) => assignment.id);
    const rows = await this.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM assignment_items
       WHERE assignment_id IN (${placeholders(ids.length)})
       ORDER BY position ASC, created_at ASC, rowid ASC`,
      ...ids,
    );
    const byAssignment = new Map<Id, AssignmentItem[]>();
    for (const row of rows) {
      const item = toItem(row);
      const bucket = byAssignment.get(item.assignment_id);
      if (bucket === undefined) byAssignment.set(item.assignment_id, [item]);
      else bucket.push(item);
    }
    return assignments.map((assignment) => ({ ...assignment, items: byAssignment.get(assignment.id) ?? [] }));
  }

  async listActive(): Promise<Assignment[]> {
    return this.list({ status: "active" });
  }

  async listOverdue(now: DateInput): Promise<Assignment[]> {
    const rows = await this.db.all<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments
       WHERE status = 'active' AND due_at < ?
       ORDER BY due_at ASC, created_at ASC, rowid ASC`,
      storedInstant(now),
    );
    return rows.map(toAssignment);
  }

  async listDueWithin(from: DateInput, to: DateInput): Promise<Assignment[]> {
    const rows = await this.db.all<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments
       WHERE status = 'active' AND due_at >= ? AND due_at < ?
       ORDER BY due_at ASC, created_at ASC, rowid ASC`,
      storedInstant(from),
      storedInstant(to),
    );
    return rows.map(toAssignment);
  }

  async listItems(assignmentId: Id): Promise<AssignmentItem[]> {
    return this.itemsOf(this.db, assignmentId);
  }

  async getItem(id: Id): Promise<AssignmentItem | null> {
    const row = await this.db.get<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM assignment_items WHERE id = ?`,
      id,
    );
    return row === undefined ? null : toItem(row);
  }

  async addItems(assignmentId: Id, items: readonly NewAssignmentItemInput[]): Promise<AssignmentItem[]> {
    return this.db.transaction(async (tx) => {
      await this.require(tx, assignmentId);
      const writer = this.ctx.with(tx);
      const row = await tx.get<{ next: number | null }>(
        `SELECT MAX(position) + 1 AS next FROM assignment_items WHERE assignment_id = ?`,
        assignmentId,
      );
      const next = row?.next;
      const start = typeof next === "number" ? next : 0;
      const created = await this.insertItems(writer, assignmentId, items, start);
      await tx.run(
        `UPDATE assignments SET updated_at = ? WHERE id = ?`,
        writer.timestamp(),
        assignmentId,
      );
      return created;
    });
  }

  async setStatus(id: Id, status: AssignmentStatus): Promise<Assignment> {
    return this.db.transaction(async (tx) => {
      await this.require(tx, id);
      await tx.run(
        `UPDATE assignments SET status = ?, updated_at = ? WHERE id = ?`,
        status,
        this.ctx.timestamp(),
        id,
      );
      return this.require(tx, id);
    });
  }

  /** Insert items appended after `start`, honouring an explicit `position` per input. */
  private async insertItems(
    writer: SqliteExecutorContext,
    assignmentId: Id,
    inputs: readonly NewAssignmentItemInput[],
    start: number,
  ): Promise<AssignmentItem[]> {
    const created: AssignmentItem[] = [];
    for (const [index, input] of inputs.entries()) {
      const item: AssignmentItem = {
        id: writer.id(),
        assignment_id: assignmentId,
        label: input.label,
        note: input.note ?? null,
        position: input.position ?? start + index,
        created_at: writer.timestamp(),
      };
      await writer.tx.run(
        `INSERT INTO assignment_items (id, assignment_id, label, note, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        item.id,
        item.assignment_id,
        item.label,
        item.note,
        item.position,
        item.created_at,
      );
      created.push(item);
    }
    return created;
  }
}
