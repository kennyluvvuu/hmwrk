/**
 * `TgBindingsRepo` over SQLite (SPEC §5.6 `tg_bindings`).
 *
 * One chat per user in the MVP: `user_id` is the primary key, `upsert()` re-points it and keeps
 * `created_at` (the extra T1 field) from the first binding.
 */

import type { TgBindingInput, TgBindingsRepo } from "../../domain/repo.js";
import type { Id, TgBinding } from "../../domain/types.js";
import type { SqliteContext } from "./context.js";

const BINDING_COLUMNS = "user_id, chat_id, created_at";

interface TgBindingRow {
  user_id: string;
  chat_id: string;
  created_at: string;
}

function toBinding(row: TgBindingRow): TgBinding {
  return { user_id: row.user_id, chat_id: row.chat_id, created_at: row.created_at };
}

export class SqliteTgBindingsRepo implements TgBindingsRepo {
  constructor(private readonly ctx: SqliteContext) {}

  private get db() {
    return this.ctx.db;
  }

  async upsert(input: TgBindingInput): Promise<TgBinding> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.get<TgBindingRow>(
        `SELECT ${BINDING_COLUMNS} FROM tg_bindings WHERE user_id = ?`,
        input.user_id,
      );
      if (existing === undefined) {
        const binding: TgBinding = {
          user_id: input.user_id,
          chat_id: input.chat_id,
          created_at: this.ctx.timestamp(),
        };
        await tx.run(
          `INSERT INTO tg_bindings (user_id, chat_id, created_at) VALUES (?, ?, ?)`,
          binding.user_id,
          binding.chat_id,
          binding.created_at,
        );
        return binding;
      }
      await tx.run(`UPDATE tg_bindings SET chat_id = ? WHERE user_id = ?`, input.chat_id, input.user_id);
      return { ...toBinding(existing), chat_id: input.chat_id };
    });
  }

  async getByUserId(userId: Id): Promise<TgBinding | null> {
    const row = await this.db.get<TgBindingRow>(
      `SELECT ${BINDING_COLUMNS} FROM tg_bindings WHERE user_id = ?`,
      userId,
    );
    return row === undefined ? null : toBinding(row);
  }

  async list(): Promise<TgBinding[]> {
    const rows = await this.db.all<TgBindingRow>(
      `SELECT ${BINDING_COLUMNS} FROM tg_bindings ORDER BY created_at ASC, rowid ASC`,
    );
    return rows.map(toBinding);
  }

  async remove(userId: Id): Promise<boolean> {
    const removed = await this.db.runCounted(`DELETE FROM tg_bindings WHERE user_id = ?`, userId);
    return removed > 0;
  }
}
