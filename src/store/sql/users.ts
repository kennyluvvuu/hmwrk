/**
 * `UsersRepo` over SQLite (SPEC §4, ADR 0004 `users`).
 *
 * `openwebui_user_id` is `UNIQUE`: `create()` on a known account is a `ConflictError` (the fakes' behaviour),
 * while `upsert()` is the login-time path that syncs role and name without changing `created_at`.
 */

import { ConflictError, NotFoundError } from "../../domain/errors.js";
import type { NewUserInput, UsersRepo } from "../../domain/repo.js";
import type { Id, Role, User } from "../../domain/types.js";
import type { SqliteContext } from "./context.js";

const USER_COLUMNS = "id, openwebui_user_id, role, name, created_at";

interface UserRow {
  id: string;
  openwebui_user_id: string;
  role: string;
  name: string;
  created_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    openwebui_user_id: row.openwebui_user_id,
    role: row.role as Role,
    name: row.name,
    created_at: row.created_at,
  };
}

export class SqliteUsersRepo implements UsersRepo {
  constructor(private readonly ctx: SqliteContext) {}

  private get db() {
    return this.ctx.db;
  }

  async create(input: NewUserInput): Promise<User> {
    const existing = await this.db.get<{ id: string }>(
      `SELECT id FROM users WHERE openwebui_user_id = ?`,
      input.openwebui_user_id,
    );
    if (existing !== undefined) {
      throw new ConflictError(`User with OpenWebUI id ${input.openwebui_user_id} already exists`);
    }
    const user: User = {
      id: this.ctx.id(),
      openwebui_user_id: input.openwebui_user_id,
      role: input.role,
      name: input.name,
      created_at: this.ctx.timestamp(),
    };
    await this.db.run(
      `INSERT INTO users (id, openwebui_user_id, role, name, created_at) VALUES (?, ?, ?, ?, ?)`,
      user.id,
      user.openwebui_user_id,
      user.role,
      user.name,
      user.created_at,
    );
    return user;
  }

  async upsert(input: NewUserInput): Promise<User> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.get<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users WHERE openwebui_user_id = ?`,
        input.openwebui_user_id,
      );
      if (existing === undefined) {
        const created: User = {
          id: this.ctx.id(),
          openwebui_user_id: input.openwebui_user_id,
          role: input.role,
          name: input.name,
          created_at: this.ctx.timestamp(),
        };
        await tx.run(
          `INSERT INTO users (id, openwebui_user_id, role, name, created_at) VALUES (?, ?, ?, ?, ?)`,
          created.id,
          created.openwebui_user_id,
          created.role,
          created.name,
          created.created_at,
        );
        return created;
      }
      await tx.run(
        `UPDATE users SET role = ?, name = ? WHERE id = ?`,
        input.role,
        input.name,
        existing.id,
      );
      return { ...toUser(existing), role: input.role, name: input.name };
    });
  }

  async get(id: Id): Promise<User | null> {
    const row = await this.db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id);
    return row === undefined ? null : toUser(row);
  }

  async getByOpenWebUiId(openwebuiUserId: string): Promise<User | null> {
    const row = await this.db.get<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE openwebui_user_id = ?`,
      openwebuiUserId,
    );
    return row === undefined ? null : toUser(row);
  }

  async list(): Promise<User[]> {
    const rows = await this.db.all<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC, rowid ASC`,
    );
    return rows.map(toUser);
  }

  async listByRole(role: Role): Promise<User[]> {
    const rows = await this.db.all<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE role = ? ORDER BY created_at ASC, rowid ASC`,
      role,
    );
    return rows.map(toUser);
  }

  async setRole(id: Id, role: Role): Promise<User> {
    const changed = await this.db.runCounted(`UPDATE users SET role = ? WHERE id = ?`, role, id);
    const user = await this.get(id);
    if (changed === 0 || user === null) throw new NotFoundError(`User ${id} not found`);
    return user;
  }
}
