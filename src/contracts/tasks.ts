/**
 * Module contract: starting durable tasks from the agent tools (A2) and from boot wiring (I2).
 *
 * The contract is deliberately tiny: a tool that reacts to a check-in only needs «start verification
 * for this check-in» and a task id to mention in the tool result. Everything else the nine SPEC §5.5
 * tools touch goes through the domain repository contracts (T1), so this file stays free of
 * pi-durable, SQL and Telegram.
 *
 * The implementation lives in `src/durable/tasks/verify.ts` (`createVerifySpawner`), which owns the
 * task name, the ownership conversation and `Harness.resume()` (K9).
 */

/** Starts the two-stage verification of one check-in (SPEC §5.4). Idempotency by checkInId belongs to the implementation. */
export interface VerifySpawner {
  startVerify(input: { checkInId: string }): Promise<{ taskId: string }>;
}

export interface ToolDeps {
  repos: import("../domain/index.js").Repos;
  spawnVerify: VerifySpawner;
  now(): Date;
}
