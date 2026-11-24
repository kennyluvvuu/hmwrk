/**
 * The M2 turn runner: a real agent run instead of the M1 echo (I2, SPEC §3/§6).
 *
 * One HTTP request is one durable submission:
 *
 * 1. `watchText()` attaches **before** `submitUserInput()` (K5) — the model may start answering in
 *    the same tick, and attaching late loses the first tokens. The watch replays what is already
 *    there, so an early attach costs nothing;
 * 2. `submitUserInput({ requestId })` admits the input durably (K4). The same `requestId` from a
 *    retried HTTP request returns the same submission and starts no second run, which is what makes
 *    OpenWebUI's retries free;
 * 3. deltas are streamed to the client as they appear — they are a live-view illusion over
 *    `docs["pi.live"].generation.message`, and the *authoritative* text is `settle()`'s (K5/R1);
 * 4. so the last piece is always corrected from the settlement: deltas can lag one partial commit
 *    behind, and a client that stopped at the last delta would read a truncated answer. After
 *    `settle()` the runner appends whatever tail is missing;
 * 5. a disconnected client aborts the run (`pending.abort()`), because nobody will read the answer.
 *
 * Errors are `TurnOutcome`s, not exceptions: an unanswered run still has to send OpenAI a
 * `finish_reason` (an aborted turn is not an HTTP error, K5).
 */

import type { Logger } from "../config/index.js";
import type { Core, PendingTurn, TextStream, TurnResult } from "../contracts/harness.js";
import { finishReasonFromTurn, usageFromPiUsage } from "./openai-mappers.js";
import type { TurnOutcome, TurnRequest, TurnRunner } from "./routes.js";

/** The slice of {@link Core} a generation needs (structurally satisfied by the real core). */
export type GenerationCore = Pick<Core, "submitUserInput" | "watchText" | "abort">;

export interface GenerationRunnerOptions {
  readonly logger?: Logger;
}

/**
 * Build the runner `createApp` uses in M2. Kept free of Hono and of the photo/turn plumbing in
 * `routes.ts`: it only knows «one request → one submission → one settled answer».
 */
export function generationTurnRunner(core: GenerationCore, options: GenerationRunnerOptions = {}): TurnRunner {
  const logger = options.logger;

  return async ({ conversation, input, requestId, onTextDelta, signal }: TurnRequest): Promise<TurnOutcome> => {
    let received = "";
    let stream: TextStream;
    try {
      stream = await core.watchText(conversation, (delta) => {
        received += delta;
        onTextDelta?.(delta);
      });
    } catch (error) {
      // No live view is a degraded stream, not a failed turn: `settle()` still produces the answer.
      logger?.warn("could not attach to the live answer; falling back to the settled text", { error });
      stream = { stop: async () => undefined };
    }

    let pending: PendingTurn;
    try {
      pending = await core.submitUserInput(conversation, input.input, { requestId });
    } catch (error) {
      await settleQuietly(stream);
      throw error;
    }

    // Client went away: stop the run instead of generating into a closed socket (K4/K5).
    const abort = (): void => {
      void pending.abort().catch((error: unknown) => {
        logger?.warn("aborting the turn after a client disconnect failed", { error });
      });
    };
    if (signal?.aborted === true) abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const result = await pending.settle();
      return outcomeOf(result, received, onTextDelta, logger);
    } finally {
      signal?.removeEventListener("abort", abort);
      await settleQuietly(stream);
    }
  };
}

/** Turn result → what the HTTP layer answers, including the delta-tail correction. */
export function outcomeOf(
  result: TurnResult,
  received: string,
  onTextDelta: ((delta: string) => void) | undefined,
  logger?: Logger,
): TurnOutcome {
  const text = result.text === "" ? received : result.text;

  if (onTextDelta !== undefined) {
    // `received` is normally a prefix of the final text; a divergence means the deltas came from a
    // different partial (a reset/retry) and the client must get the whole authoritative text.
    const tail = text.startsWith(received) ? text.slice(received.length) : text;
    if (tail !== "") onTextDelta(tail);
  }

  if (result.status === "unanswered") {
    logger?.warn("turn ended without an answer", {
      reason: result.failure?.reason,
      detail: result.failure?.detail,
      partialChars: received.length,
    });
  }

  return {
    text,
    finishReason: finishReasonFromTurn(result),
    ...(result.usage === undefined ? {} : { usage: usageFromPiUsage(result.usage) }),
  };
}

/** `stream.stop()` never needs to fail the turn. */
async function settleQuietly(stream: TextStream): Promise<void> {
  try {
    await stream.stop();
  } catch {
    // Detaching is best-effort by contract: `stop()` does not touch the run (K5).
  }
}
