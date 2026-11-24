/**
 * S1: turns — echo (M1, R1 K6), generation over the faux provider (M2 shape, K4/K5) and abort.
 *
 * No real model is called: every generation goes through pi-ai's faux provider.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, type FauxProviderHandle } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHarness, type Core, type CoreConversation } from "../contracts/harness.js";
import { fauxModels, makeTempDir, silentLogger, testConfig, type TempDir } from "./testkit.js";

let temp: TempDir;
let core: Core | undefined;
let conversation: CoreConversation;
let faux: FauxProviderHandle;

/** Opens a core over a temp file with a faux provider paced as the test needs. */
async function setup(fauxOptions?: Parameters<typeof fauxModels>[0]): Promise<void> {
  const providers = fauxModels(fauxOptions);
  faux = providers.faux;
  core = await openHarness(testConfig(temp.dir), { models: providers.models, logger: silentLogger() });
  await core.resume();
  conversation = await core.getOrCreateConversation("key:child", "child");
}

function open(): Core {
  if (core === undefined) throw new Error("core is not open");
  return core;
}

beforeEach(() => {
  temp = makeTempDir();
});

afterEach(async () => {
  if (core !== undefined) {
    await core.close().catch(() => undefined);
    core = undefined;
  }
  temp.remove();
});

describe("echo (M1, K6)", () => {
  it("writes pi.user and pi.assistant in one commit and returns the text", async () => {
    await setup();

    const turn = await open().echo(conversation, "привет");

    expect(turn.conversationId).toBe(conversation.id);
    expect(turn.text).toBe("привет");
    expect(turn.userEntryId).not.toBe(turn.assistantEntryId);

    const view = await conversation.handle.context(BACKGROUND_CONTEXT);
    expect(view.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
    expect(view.entries[1]?.id).toBe(turn.assistantEntryId);

    const assistant = view.entries[1]?.model?.[0] as AssistantMessage;
    expect(assistant.content).toEqual([{ type: "text", text: "привет" }]);
    expect(assistant.stopReason).toBe("stop");

    // No model, no task, no submission: echo is not generation (which is why it costs nothing in M1).
    const inspection = await open().harness.inspect(BACKGROUND_CONTEXT);
    expect(inspection.tasks).toHaveLength(0);
    expect(inspection.submissions).toHaveLength(0);
    expect(faux.state.callCount).toBe(0);
  });

  it("adds a pair per call — M1 accepts duplicates from client retries (R1 observation #9)", async () => {
    await setup();

    await open().echo(conversation, "раз", { requestId: "req-1" });
    await open().echo(conversation, "раз", { requestId: "req-1" });

    const view = await conversation.handle.context(BACKGROUND_CONTEXT);
    expect(view.entries).toHaveLength(4);
  });
});

describe("generation (M2 shape, K4/K5)", () => {
  it("settles with the assistant text, stop reason and usage from the answer entry", async () => {
    await setup();
    faux.setResponses([fauxAssistantMessage("ответ модели")]);

    const pending = await open().submitUserInput(conversation, "вопрос");
    expect(pending.requestId).toEqual(expect.any(String));

    const result = await pending.settle();
    expect(result.status).toBe("done");
    expect(result.text).toBe("ответ модели");
    expect(result.stopReason).toBe("stop");
    expect(result.answerEntryId).toBeDefined();
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
    expect(result.failure).toBeUndefined();
  });

  it("treats a repeated requestId as the same submission (K4 idempotency)", async () => {
    await setup();
    faux.setResponses([fauxAssistantMessage("единственный ответ")]);

    const first = await open().submitUserInput(conversation, "вопрос", { requestId: "req-idem" });
    const second = await open().submitUserInput(conversation, "вопрос", { requestId: "req-idem" });

    expect(second.submission.id).toBe(first.submission.id);
    expect((await second.settle()).text).toBe("единственный ответ");
    expect(faux.state.callCount).toBe(1);
  });

  it("formats a failed run as unanswered instead of throwing (K4)", async () => {
    await setup();
    // No scripted response: the faux provider answers with an error message, so the run fails `model_error`.
    const result = await (await open().submitUserInput(conversation, "вопрос в пустоту")).settle();

    expect(result.status).toBe("unanswered");
    expect(result.text).toBe("");
    expect(result.failure?.reason).toBe("model_error");
  });

  it("streams text deltas that build up to the settled answer (K5)", async () => {
    await setup({ tokensPerSecond: 120 });
    const answer = "Живой ответ модели, который приходит частями и складывается в целый текст.";
    faux.setResponses([fauxAssistantMessage(answer)]);

    const deltas: string[] = [];
    const stream = await open().watchText(conversation, (delta) => {
      deltas.push(delta);
    });
    const result = await (await open().submitUserInput(conversation, "расскажи")).settle();
    await stream.stop();
    await stream.stop(); // idempotent: S2 stops in a finally block

    expect(result.status).toBe("done");
    expect(result.text).toBe(answer);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((delta) => delta.length > 0)).toBe(true);
    // Deltas are a live-view illusion (R1 K5): they may lag the final text, never exceed it.
    expect(answer.startsWith(deltas.join(""))).toBe(true);
  }, 30_000);

  it("aborts a running answer, leaving an `aborted` entry and an unanswered turn (K5/K11)", async () => {
    await setup({ tokensPerSecond: 10 });
    faux.setResponses([fauxAssistantMessage("очень длинный ответ ".repeat(20))]);

    let onFirstDelta: () => void = () => undefined;
    const sawDelta = new Promise<void>((resolve) => {
      onFirstDelta = resolve;
    });
    const stream = await open().watchText(conversation, () => {
      onFirstDelta();
    });

    const pending = await open().submitUserInput(conversation, "долгий вопрос");
    await sawDelta;
    await open().abort(conversation);
    const result = await pending.settle();
    await stream.stop();

    expect(result.status).toBe("unanswered");
    expect(result.failure?.reason).toBe("aborted");

    const view = await conversation.handle.context(BACKGROUND_CONTEXT);
    const last = view.entries.at(-1);
    expect(last?.kind).toBe("pi.assistant");
    const message = last?.model?.[0] as AssistantMessage;
    expect(message.stopReason).toBe("aborted");

    // The conversation is usable again right away.
    faux.setResponses([fauxAssistantMessage("после отмены")]);
    const next = await (await open().submitUserInput(conversation, "ещё вопрос")).settle();
    expect(next.text).toBe("после отмены");
  }, 30_000);
});
