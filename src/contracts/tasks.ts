/**
 * Module contract: what the agent tools (A2) need from the durable side (V2/I2).
 *
 * One dependency only — starting a verification. Everything else the nine SPEC §5.5 tools touch
 * goes through the domain repository contracts (T1), so this file stays free of pi-durable,
 * SQL and Telegram: the tools do not know how a verify task is created, only that a check-in id
 * is enough to start one (K9: a durable task, idempotent by that id inside the implementation).
 *
 * Written by A2, consumed by I2 (wiring) and V2 (the verify task itself).
 */

import type { ToolName } from "../domain/index.js";

export interface VerifySpawner {
  /** Запустить проверку отчёта. Идемпотентность по checkInId — забота реализации. */
  startVerify(input: { checkInId: string }): Promise<{ taskId: string }>;
}

export interface ToolDeps {
  repos: import("../domain/index.js").Repos;
  spawnVerify: VerifySpawner;
  now(): Date;
}
