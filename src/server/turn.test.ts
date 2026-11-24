/**
 * The generation turn runner (I2): deltas in, one settled answer out.
 *
 * No harness here — the runner is a thin policy over four `Core` methods, so a hand-written core
 * is enough to pin the three behaviours that matter:
 *
 * 1. `watchText` is attached **before** `submitUserInput` (K5: the first tokens must not be lost);
 * 2. the client always ends with the settled text, even when the last delta lags one partial
 *    commit behind (K5/R1) — without this the streamed answer can be truncated;
 * 3. a client disconnect aborts the run (`pending.abort()`), and the partial text is still a
 *    well-formed `TurnOutcome`.
 */
import { describe, expect, it } from "vitest";
import type { Core, CoreConversation, PendingTurn, TextStream, TurnResult } from "../contracts/harness.js";
import { generationTurnRunner } from "./turn.js";

const conversation = { id: 1, userId: "key:parent", role: "parent" } as unknown as CoreConversation;

interface FakeCoreOptions {
  /** Text the partial-answer watch replays/receives while the run is live. */
  readonly deltas?: readonly string[];
  readonly settle: (emit: (delta: string) => void) => Promise<TurnResult>;
}

interface Recorded {
  readonly order: string[];
  abortCalls: number;
  readonly submitted: { input: unknown; requestId: string }[];
}

function fakeCore(options: FakeCoreOptions): { core: Pick<Core, "submitUserInput" | "watchText" | "abort">; recorded: Recorded } {
  const recorded: Recorded = { order: [], abortCalls: 0, submitted: [] };
  let emit: (delta: string) => void = () => undefined;

  const stream: TextStream = { stop: async () => undefined };

  const core = {
    async watchText(_conversation: CoreConversation, listener: (delta: string) => void): Promise<TextStream> {
      recorded.order.push("watchText");
      emit = listener;
      return stream;
    },
    async submitUserInput(_conversation: CoreConversation, input: unknown, submitOptions?: { requestId?: string }): Promise<PendingTurn> {
      recorded.order.push("submit");
      recorded.submitted.push({ input, requestId: submitOptions?.requestId ?? "" });
      // Deltas arrive only once the run is admitted, exactly like the real live document.
      for (const delta of options.deltas ?? []) emit(delta);
      return {
        submission: {} as PendingTurn["submission"],
        requestId: submitOptions?.requestId ?? "",
        settle: () => options.settle(emit),
        abort: async () => {
          recorded.abortCalls += 1;
          return "aborted" as const;
        },
      };
    },
    async abort(): Promise<void> {
      recorded.abortCalls += 1;
    },
  };

  return { core, recorded };
}

const baseRequest = { conversation, requestId: "req-1" } as const;
const input = { input: "привет", text: "привет", images: 0 };

describe("generationTurnRunner", () => {
  it("attaches the watch before submitting and streams the deltas", async () => {
    const { core, recorded } = fakeCore({
      deltas: ["при", "вет"],
      settle: async () => ({ status: "done", text: "привет", stopReason: "stop" }),
    });

    const chunks: string[] = [];
    const outcome = await generationTurnRunner(core)({
      ...baseRequest,
      input,
      onTextDelta: (delta) => chunks.push(delta),
    });

    expect(recorded.order).toEqual(["watchText", "submit"]);
    expect(chunks.join("")).toBe("привет");
    expect(outcome).toEqual({ text: "привет", finishReason: "stop" });
    expect(recorded.submitted[0]?.requestId).toBe("req-1");
  });

  it("finishes with the tail the deltas missed (K5/R1)", async () => {
    const { core } = fakeCore({
      deltas: ["при"],
      settle: async () => ({ status: "done", text: "привет, как дела?", stopReason: "stop" }),
    });

    const chunks: string[] = [];
    const outcome = await generationTurnRunner(core)({
      ...baseRequest,
      input,
      onTextDelta: (delta) => chunks.push(delta),
    });

    expect(chunks.join("")).toBe("привет, как дела?");
    expect(outcome.text).toBe("привет, как дела?");
  });

  it("does not repeat text when the deltas were already complete", async () => {
    const { core } = fakeCore({
      deltas: ["привет"],
      settle: async () => ({ status: "done", text: "привет", stopReason: "stop" }),
    });

    const chunks: string[] = [];
    await generationTurnRunner(core)({ ...baseRequest, input, onTextDelta: (delta) => chunks.push(delta) });
    expect(chunks).toEqual(["привет"]);
  });

  it("aborts the run when the client disconnects and keeps the partial text", async () => {
    const controller = new AbortController();
    const { core, recorded } = fakeCore({
      deltas: ["прив"],
      settle: () =>
        new Promise<TurnResult>((resolve) => {
          // The client goes away mid-answer; the runner's abort listener must fire.
          setTimeout(() => controller.abort(), 5);
          setTimeout(() => resolve({ status: "unanswered", text: "", failure: { reason: "aborted" } }), 20);
        }),
    });

    const outcome = await generationTurnRunner(core)({
      ...baseRequest,
      input,
      signal: controller.signal,
      onTextDelta: () => undefined,
    });

    expect(recorded.abortCalls).toBe(1);
    expect(outcome).toMatchObject({ text: "прив", finishReason: "stop" });
  });

  it("maps usage and a length stop into the OpenAI vocabulary", async () => {
    const { core } = fakeCore({
      settle: async () => ({
        status: "done",
        text: "обрезано",
        stopReason: "length",
        usage: {
          input: 10,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 14,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    });

    const outcome = await generationTurnRunner(core)({ ...baseRequest, input });

    expect(outcome.finishReason).toBe("length");
    expect(outcome.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });
});
