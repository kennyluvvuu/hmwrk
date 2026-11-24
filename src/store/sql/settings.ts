/**
 * `SettingsRepo` over SQLite (SPEC §5.2 `settings`, §5.7).
 *
 * The table is key/value with a JSON `value`; the repository speaks the typed {@link Settings} object and
 * returns **effective** settings (stored overrides merged onto the defaults of `src/domain/settings.ts`).
 *
 * Two rules are inherited from the fakes and keep the two implementations interchangeable:
 * - writers validate with `parseSettingValue` (zod, `src/domain/schemas.ts`) and throw `InvalidValueError`;
 * - readers never fail on a corrupt row: `resolveSettings` drops unparsable values and the default wins, so
 *   a bad `settings` row cannot stop the core from booting.
 */

import { parseSettingValue } from "../../domain/schemas.js";
import { resolveSettings } from "../../domain/settings.js";
import type { SettingsRepo } from "../../domain/repo.js";
import type { SettingKey, Settings } from "../../domain/types.js";
import type { SqliteContext } from "./context.js";

interface SettingRow {
  key: string;
  value: string;
}

export class SqliteSettingsRepo implements SettingsRepo {
  constructor(private readonly ctx: SqliteContext) {}

  private get db() {
    return this.ctx.db;
  }

  /** Stored overrides, JSON-decoded; unreadable rows are skipped (defaults win). */
  private async stored(): Promise<Partial<Settings>> {
    const rows = await this.db.all<SettingRow>(`SELECT key, value FROM settings`);
    const overrides: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        overrides[row.key] = JSON.parse(row.value);
      } catch {
        // A corrupt row is deleted rather than silently kept: it would fail on every boot otherwise.
        await this.db.run(`DELETE FROM settings WHERE key = ?`, row.key);
      }
    }
    return overrides as Partial<Settings>;
  }

  async getAll(): Promise<Settings> {
    return resolveSettings(await this.stored());
  }

  async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
    const settings = await this.getAll();
    return settings[key];
  }

  async set<K extends SettingKey>(key: K, value: Settings[K]): Promise<Settings> {
    const validated = parseSettingValue(key, value);
    await this.db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      JSON.stringify(validated),
    );
    return this.getAll();
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const entries = Object.entries(patch).filter(
      (entry): entry is [SettingKey, Settings[SettingKey]] => entry[1] !== undefined,
    );
    if (entries.length === 0) return this.getAll();
    return this.db.transaction(async (tx) => {
      for (const [key, value] of entries) {
        await tx.run(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          key,
          JSON.stringify(parseSettingValue(key, value)),
        );
      }
      const rows = await tx.all<SettingRow>(`SELECT key, value FROM settings`);
      const overrides: Record<string, unknown> = {};
      for (const row of rows) {
        try {
          overrides[row.key] = JSON.parse(row.value);
        } catch {
          // Cannot DELETE through this handle after the loop above; `getAll()` cleans it on the next read.
        }
      }
      return resolveSettings(overrides as Partial<Settings>);
    });
  }
}
