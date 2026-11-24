/**
 * Module contract: starting durable tasks from the agent tools (A2) and from boot wiring (I2).
 *
 * The contract is deliberately tiny: a tool that reacts to a check-in only needs «start verification
 * for this check-in» and a task id to mention in the tool result. The implementation lives in
 * `src/durable/tasks/verify.ts` (`createVerifySpawner`), which owns the task name, the ownership
 * conversation and `Harness.resume()`.
 */

/** Starts the two-stage verification of one check-in (SPEC §5.4). */
export interface VerifySpawner {
  startVerify(input: { checkInId: string }): Promise<{ taskId: string }>;
}
