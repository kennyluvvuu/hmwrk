/**
 * `VerificationsRepo` over SQLite (SPEC §5.2 `verifications`, `verification_findings`).
 *
 * The interesting query is {@link SqliteVerificationsRepo.listPending}: only the **latest** verification per
 * check-in counts, and it counts only while it is a draft — a draft superseded by a recompute is not pending,
 * and neither is one whose check-in already got a decision. The in-memory fake expresses that as «walk in
 * creation order, keep last draft per check-in, drop on a decided row»; here it is a correlated subquery on
 * `rowid`, which also breaks ties when several rows share one `created_at` (frozen clock).
 *
 * `decide()` goes through `applyVerificationAction` from `src/domain/status.ts`, so a second decision throws
 * `InvalidTransitionError` exactly as the fakes do.
 */

import type { SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { asDate, toIso } from "../../domain/dates.js";
import { NotFoundError } from "../../domain/errors.js";
import type {
  NewVerificationInput,
  VerificationFilter,
  VerificationListFilter,
  VerificationsRepo,
} from "../../domain/repo.js";
import { applyVerificationAction } from "../../domain/status.js";
import type {
  DateInput,
  FindingVerdict,
  Id,
  Verification,
  VerificationFinding,
  VerificationStatus,
  VerificationWithFindings,
} from "../../domain/types.js";
import { paginate, placeholders, type SqliteContext } from "./context.js";

const VERIFICATION_COLUMNS =
  "id, checkin_id, status, summary, model, created_at, decided_at, decided_by_user_id";
/** Same columns qualified with the `v` alias used by queries that join `checkins`. */
const VERIFICATION_COLUMNS_V =
  "v.id, v.checkin_id, v.status, v.summary, v.model, v.created_at, v.decided_at, v.decided_by_user_id";
const FINDING_COLUMNS = "verification_id, item_id, verdict, comment";

interface VerificationRow {
  id: string;
  checkin_id: string;
  status: string;
  summary: string;
  model: string;
  created_at: string;
  decided_at: string | null;
  decided_by_user_id: string | null;
}

interface FindingRow {
  verification_id: string;
  item_id: string;
  verdict: string;
  comment: string | null;
}

function toVerification(row: VerificationRow): Verification {
  return {
    id: row.id,
    checkin_id: row.checkin_id,
    status: row.status as VerificationStatus,
    summary: row.summary,
    model: row.model,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by_user_id: row.decided_by_user_id,
  };
}

function toFinding(row: FindingRow): VerificationFinding {
  return {
    verification_id: row.verification_id,
    item_id: row.item_id,
    verdict: row.verdict as FindingVerdict,
    comment: row.comment,
  };
}

function statusesOf(filter: VerificationFilter): VerificationStatus[] | null {
  const status = filter.status;
  if (status === undefined) return null;
  return Array.isArray(status)
    ? [...(status as readonly VerificationStatus[])]
    : [status as VerificationStatus];
}

/** `WHERE …` of a verification query with an optional status set. */
function statusClause(statuses: VerificationStatus[] | null, column = "status"): { sql: string; params: SqliteValue[] } {
  if (statuses === null) return { sql: "", params: [] };
  if (statuses.length === 0) return { sql: " AND 0", params: [] };
  return { sql: ` AND ${column} IN (${placeholders(statuses.length)})`, params: [...statuses] };
}

export class SqliteVerificationsRepo implements VerificationsRepo {
  constructor(private readonly ctx: SqliteContext) {}

  private get db() {
    return this.ctx.db;
  }

  private async row(executor: SqliteExecutor, id: Id): Promise<VerificationRow | undefined> {
    return executor.get<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS} FROM verifications WHERE id = ?`,
      id,
    );
  }

  private async require(executor: SqliteExecutor, id: Id): Promise<Verification> {
    const row = await this.row(executor, id);
    if (row === undefined) throw new NotFoundError(`Verification ${id} not found`);
    return toVerification(row);
  }

  private async findingsOf(executor: SqliteExecutor, verificationId: Id): Promise<VerificationFinding[]> {
    const rows = await executor.all<FindingRow>(
      `SELECT ${FINDING_COLUMNS} FROM verification_findings
       WHERE verification_id = ?
       ORDER BY rowid ASC`,
      verificationId,
    );
    return rows.map(toFinding);
  }

  private async withFindings(
    executor: SqliteExecutor,
    verification: Verification,
  ): Promise<VerificationWithFindings> {
    return { ...verification, findings: await this.findingsOf(executor, verification.id) };
  }

  async createDraft(input: NewVerificationInput): Promise<VerificationWithFindings> {
    const id = this.ctx.id();
    const now = this.ctx.timestamp();
    return this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO verifications
           (id, checkin_id, status, summary, model, created_at, decided_at, decided_by_user_id)
         VALUES (?, ?, 'draft', ?, ?, ?, NULL, NULL)`,
        id,
        input.checkin_id,
        input.summary,
        input.model,
        now,
      );
      for (const finding of input.findings) {
        await tx.run(
          `INSERT OR REPLACE INTO verification_findings (verification_id, item_id, verdict, comment)
           VALUES (?, ?, ?, ?)`,
          id,
          finding.item_id,
          finding.verdict,
          finding.comment ?? null,
        );
      }
      const verification = await this.require(tx, id);
      return this.withFindings(tx, verification);
    });
  }

  async get(id: Id): Promise<Verification | null> {
    const row = await this.row(this.db, id);
    return row === undefined ? null : toVerification(row);
  }

  async getWithFindings(id: Id): Promise<VerificationWithFindings | null> {
    const row = await this.row(this.db, id);
    if (row === undefined) return null;
    return this.withFindings(this.db, toVerification(row));
  }

  async listByCheckIn(checkinId: Id): Promise<Verification[]> {
    const rows = await this.db.all<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS} FROM verifications
       WHERE checkin_id = ?
       ORDER BY created_at ASC, rowid ASC`,
      checkinId,
    );
    return rows.map(toVerification);
  }

  async list(filter: VerificationListFilter = {}): Promise<Verification[]> {
    const conditions: string[] = [];
    const params: SqliteValue[] = [];
    if (filter.checkinId !== undefined) {
      conditions.push("checkin_id = ?");
      params.push(filter.checkinId);
    }
    const statuses = statusesOf(filter);
    if (statuses !== null) {
      if (statuses.length === 0) conditions.push("0");
      else {
        conditions.push(`status IN (${placeholders(statuses.length)})`);
        params.push(...statuses);
      }
    }
    const limit = paginate(filter.limit, undefined);
    const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
    const rows = await this.db.all<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS} FROM verifications${where}
       ORDER BY created_at ASC, rowid ASC${limit.sql}`,
      ...params,
      ...limit.params,
    );
    return rows.map(toVerification);
  }

  async listByAssignment(assignmentId: Id, filter: VerificationFilter = {}): Promise<Verification[]> {
    const statuses = statusesOf(filter);
    const status = statusClause(statuses, "v.status");
    const rows = await this.db.all<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS_V}
       FROM verifications v
       JOIN checkins c ON c.id = v.checkin_id
       WHERE c.assignment_id = ?${status.sql}
       ORDER BY v.created_at ASC, v.rowid ASC`,
      assignmentId,
      ...status.params,
    );
    return rows.map(toVerification);
  }

  async latestForCheckIn(checkinId: Id): Promise<VerificationWithFindings | null> {
    const row = await this.db.get<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS} FROM verifications
       WHERE checkin_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      checkinId,
    );
    if (row === undefined) return null;
    return this.withFindings(this.db, toVerification(row));
  }

  async latestDraftForCheckIn(checkinId: Id): Promise<VerificationWithFindings | null> {
    const latest = await this.latestForCheckIn(checkinId);
    return latest !== null && latest.status === "draft" ? latest : null;
  }

  async listDrafts(): Promise<Verification[]> {
    return this.list({ status: "draft" });
  }

  async listPending(): Promise<Verification[]> {
    const rows = await this.db.all<VerificationRow>(
      `SELECT ${VERIFICATION_COLUMNS} FROM verifications v
       WHERE v.status = 'draft'
         AND v.rowid = (
           SELECT x.rowid FROM verifications x
           WHERE x.checkin_id = v.checkin_id
           ORDER BY x.created_at DESC, x.rowid DESC
           LIMIT 1
         )
       ORDER BY v.created_at ASC, v.rowid ASC`,
    );
    return rows.map(toVerification);
  }

  async findings(verificationId: Id): Promise<VerificationFinding[]> {
    return this.findingsOf(this.db, verificationId);
  }

  async decide(
    id: Id,
    decision: "approved" | "dismissed",
    decidedByUserId: Id | null,
    decidedAt?: DateInput,
  ): Promise<Verification> {
    return this.db.transaction(async (tx) => {
      const verification = await this.require(tx, id);
      const next = applyVerificationAction(
        verification.status,
        decision === "approved" ? "approve" : "dismiss",
      );
      const stamp = decidedAt === undefined ? this.ctx.timestamp() : toIso(asDate(decidedAt));
      await tx.run(
        `UPDATE verifications SET status = ?, decided_at = ?, decided_by_user_id = ? WHERE id = ?`,
        next,
        stamp,
        decidedByUserId,
        id,
      );
      return this.require(tx, id);
    });
  }
}
