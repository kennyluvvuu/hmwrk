/**
 * Binds a Telegram chat to a role (SPEC §5.6 `tg_bindings`), non-interactively.
 *
 * ```bash
 * # host (repo root), DATA_DIR from .env
 * node --import tsx scripts/bind-telegram.ts parent 123456789
 * node --import tsx scripts/bind-telegram.ts child  987654321
 *
 * # docker compose (from deploy/)
 * docker compose exec hmwrk node --import tsx scripts/bind-telegram.ts parent 123456789
 * ```
 *
 * Why a script and not a chat command: the bot only sends (`sendMessage`), it never reads
 * updates, so it cannot learn a chat id by itself. See `docs/telegram-setup.md`.
 *
 * Exit codes: `0` — bound (or re-bound), `1` — bad arguments / no such user / database error.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { loadEnv, type EnvSource } from "../src/config/env.js";
import { createLogger, type Logger } from "../src/config/logger.js";
import { bindRoleChat, parseChatId, parseRole } from "../src/telegram/bind.js";
import { openDomain } from "../src/store/index.js";

export interface RunBindScriptOptions {
  /** CLI arguments after the script name, e.g. `["parent", "123456789"]`. */
  readonly argv: readonly string[];
  /** Environment source; defaults to `process.env` (+ `.env`). */
  readonly env?: EnvSource;
  readonly logger?: Logger;
}

export interface BindScriptResult {
  readonly role: "parent" | "child";
  readonly chatId: string;
  readonly userId: string;
  readonly userName: string;
  readonly dbPath: string;
}

const USAGE = "usage: node --import tsx scripts/bind-telegram.ts <parent|child> <chat_id>";

/** Parses `argv` into exactly two positional arguments. */
export function parseBindArgs(argv: readonly string[]): { role: "parent" | "child"; chatId: string } {
  const positional = argv.filter((argument) => argument !== "");
  if (positional.length !== 2) {
    throw new Error(`${USAGE} (got ${positional.length} argument(s))`);
  }
  const [rawRole, rawChatId] = positional as [string, string];
  return { role: parseRole(rawRole), chatId: parseChatId(rawChatId) };
}

/**
 * Runs the whole bind: env → SQLite → migrate → role lookup → upsert → close.
 *
 * `loadEnv()` (not `loadConfig()`) is enough on purpose: the bind touches neither the LLM slots
 * nor models.json, so it also works on a host that has only `.env` and `DATA_DIR`.
 */
export async function runBindScript(options: RunBindScriptOptions): Promise<BindScriptResult> {
  const { role, chatId } = parseBindArgs(options.argv);
  const logger = options.logger ?? createLogger({ bindings: { module: "bind-telegram" } });
  const env = loadEnv(options.env === undefined ? {} : { env: options.env, dotenvPath: false });
  const dataDir = resolve(process.cwd(), env.DATA_DIR);
  const dbPath = join(dataDir, "hmwrk.sqlite");

  mkdirSync(dataDir, { recursive: true });
  const db = await openNodeSqliteDatabase(dbPath);
  try {
    const domain = openDomain({ db, dataDir });
    await domain.migrate();
    const result = await bindRoleChat(domain.repos, { role, chatId });
    logger.info("telegram chat bound", {
      role,
      chatId: result.binding.chat_id,
      userId: result.binding.user_id,
      userName: result.userName,
      dbPath,
    });
    return {
      role,
      chatId: result.binding.chat_id,
      userId: result.binding.user_id,
      userName: result.userName,
      dbPath,
    };
  } finally {
    await db.close();
  }
}

/** CLI entry: prints one line on success, the error message on failure, and exits accordingly. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const logger = createLogger({ bindings: { module: "bind-telegram" } });
  try {
    const result = await runBindScript({ argv, logger });
    process.stdout.write(
      `ok: ${result.role} → chat_id ${result.chatId} (user ${result.userName}, ${result.dbPath})\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`bind-telegram failed: ${message}\n`);
    return 1;
  }
}

/** True when executed as a script (`node --import tsx scripts/bind-telegram.ts …`), not imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && /bind-telegram\.[cm]?ts$/.test(entry);
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
