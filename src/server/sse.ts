/**
 * Server-Sent Events framing for `/v1/chat/completions` (SPEC §6: streaming is mandatory —
 * without it OpenWebUI shows "thinking…" until the whole answer is ready).
 *
 * The writer is deliberately generic (`emit` + a produce callback) so M2 can subscribe
 * `Core.watchText` and emit live deltas without touching the framing or the headers.
 */

/** Standard SSE response headers; `x-accel-buffering` keeps reverse proxies from buffering. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/** K5 step 4: the terminator OpenWebUI waits for. */
export const SSE_DONE = "data: [DONE]\n\n";

/** One `data: <json>\n\n` frame (OpenAI sends every chunk as a single-line JSON payload). */
export function formatSseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Writes one chunk into the stream. */
export type SseEmit = (payload: unknown) => void;

export interface SseStreamOptions {
  /**
   * Client went away (or the body was cancelled). M2 (I2) aborts the generation here, K4/K5;
   * M1's echo has already been committed by the time the stream exists, so nothing to stop.
   */
  readonly onCancel?: () => void;
}

/**
 * Builds the response body: `produce` writes chunks, the stream appends `[DONE]`.
 *
 * Errors thrown by `produce` become one OpenAI-shaped error payload followed by `[DONE]` — the
 * HTTP status is already 200 at that point, and a bare reset would leave the client hanging.
 */
export function sseBody(produce: (emit: SseEmit) => Promise<void>, options: SseStreamOptions = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let open = true;

  const push = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): void => {
    if (!open) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      // The reader is gone (client disconnect); stop writing instead of throwing.
      open = false;
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: SseEmit = (payload) => push(controller, formatSseFrame(payload));
      try {
        await produce(emit);
      } catch (error) {
        emit({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "server_error",
            code: null,
          },
        });
      } finally {
        push(controller, SSE_DONE);
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // Already closed/cancelled.
          }
        }
      }
    },
    cancel() {
      open = false;
      options.onCancel?.();
    },
  });
}
