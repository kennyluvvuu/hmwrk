/**
 * Turns, as the facade exposes them (R1 K4/K5/K6).
 *
 * Two modes, one contract:
 * - **echo** (M1): two entries (`pi.user`, `pi.assistant`) in a single commit — no model, no task, no
 *   scheduler involvement. R1 K6 picked this over a faux provider; the only cost is that `requestId`
 *   idempotency does not apply (duplicates on client retries are harmless in M1 and disappear in M2).
 * - **generation** (M2): `submit()` → `settle()` for the authoritative answer, `watchText()` for the live
 *   deltas of `docs["pi.live"].generation.message`, `abort()` to stop, `requestId` for idempotency.
 *
 * Text is always extracted from entries (`AssistantMessage.content`), never from the live document: the
 * last partial commit can lag behind the final answer (R1 K5).
 */

import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, TextContent, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  UserEntry,
  type Conversation,
  type ConversationView,
  type LiveState,
  type Submission,
  type TypedEntry,
} from "@earendil-works/pi-durable";
import type {
  EchoOptions,
  EchoTurn,
  PendingTurn,
  TextDeltaListener,
  TextStream,
  TurnResult,
  SubmitUserInputOptions,
  WatchTextOptions,
} from "../contracts/harness.js";

/** What pi-durable hands back for a settled `pi.assistant` entry. */
type AssistantEntryValue = TypedEntry<never>;

/** Text blocks of an assistant message, concatenated; `""` when there is none. */
export function assistantMessageText(message: Pick<AssistantMessage, "content"> | undefined): string {
  if (message === undefined) return "";
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * The echo answer (R1 K6 snippet): a complete `AssistantMessage` that no provider produced. It is stored
 * inside the `pi.assistant` entry, so `Conversation.context()`, `entries()` and S2's non-streaming path
 * read it back like a real answer.
 */
export function echoAssistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "echo",
    provider: "hmwrk",
    model: "echo",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

/**
 * K6 (M1): write the user input and its echo answer in one commit and report the entry ids.
 *
 * `options.requestId` is accepted and ignored on purpose (R1 observation #9): a dedupe table is only worth
 * its cost once M2 routes requests through `submitUserInput()`.
 */
export async function echoTurn(
  conversation: Conversation,
  text: string,
  _options: EchoOptions = {},
  context: Context = BACKGROUND_CONTEXT,
): Promise<EchoTurn> {
  const timestamp = Date.now();
  const userMessage: UserMessage = { role: "user", content: text, timestamp };

  const ids = await conversation.commit(
    async (tx) => {
      const user = await tx.appendEntry(UserEntry, conversation.id, { model: [userMessage] });
      const assistant = await tx.appendEntry(AssistantEntry, conversation.id, {
        model: [echoAssistantMessage(text, timestamp)],
      });
      return { userEntryId: user.id, assistantEntryId: assistant.id };
    },
    context,
  );

  return {
    conversationId: conversation.id,
    userEntryId: ids.userEntryId,
    assistantEntryId: ids.assistantEntryId,
    text,
  };
}

/**
 * K4: durable admission of one user input. Returns as soon as the input is stored, together with the two
 * ways S2 finishes the HTTP request: `settle()` for the answer, `abort()` for a client disconnect.
 */
export async function submitUserInput(
  conversation: Conversation,
  input: UserMessage["content"],
  options: SubmitUserInputOptions = {},
): Promise<PendingTurn> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const requestId = options.requestId ?? randomUUID();

  const submission = await conversation.submit(
    {
      type: "input",
      content: input,
      requestId,
      ...(options.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
    },
    context,
  );

  return {
    submission,
    requestId,
    settle: (settleContext?: Context) => settleSubmission(conversation, submission, settleContext),
    abort: (abortContext?: Context) => submission.abort(abortContext ?? BACKGROUND_CONTEXT),
  };
}

/**
 * K4: flatten the settled submission into the shape S2 answers with.
 *
 * The `answer === undefined` guard is not paranoia: `SettledSubmissionRecord` intersects instead of
 * narrowing, so `status === "done"` does not make `answer` required (R1 observation #6). `wait()` is
 * cancelled by the caller's context; the run itself continues, which is exactly what a disconnected
 * client needs.
 */
export async function settleSubmission(
  conversation: Conversation,
  submission: Submission,
  context: Context = BACKGROUND_CONTEXT,
): Promise<TurnResult> {
  const settled = await submission.wait(context);

  if (settled.status !== "done") {
    return {
      status: "unanswered",
      text: "",
      failure: {
        reason: settled.reason,
        ...(settled.detail === undefined ? {} : { detail: settled.detail }),
      },
    };
  }

  const answerId = settled.answer;
  if (answerId === undefined) {
    return { status: "unanswered", text: "", failure: { reason: "missing_answer" } };
  }

  // A read-only commit: one table read of the entry the submission points at.
  const entry: AssistantEntryValue | undefined = await conversation.commit(
    (tx) => tx.entry(AssistantEntry, answerId),
    BACKGROUND_CONTEXT,
  );
  const message = entry?.model?.[0] as AssistantMessage | undefined;

  return {
    status: "done",
    text: assistantMessageText(message),
    answerEntryId: answerId,
    stopReason: message?.stopReason,
    usage: message?.usage,
  };
}

/** Text currently visible in a conversation view's `pi.live` partial answer (K5). */
export function liveGenerationText(view: ConversationView): string {
  const live = view.docs["pi.live"] as unknown as LiveState | undefined;
  const message = live?.generation?.message as unknown as AssistantMessage | undefined;
  return assistantMessageText(message);
}

/**
 * K5: attach to the answer being generated and report the **growth** of the partial text.
 *
 * Deltas are an illusion for the client: `settle()` remains the authoritative text. `stop()` only detaches
 * — it never touches the run — and is idempotent, so S2 can call it in a `finally`. With `replay` (the
 * default) the text already on screen at attach time arrives as the first delta, which is what a client
 * wants when it attaches right after `submit()`.
 *
 * The window `{ min: 1, max: 2 }` keeps the attached view cheap: only built-in documents and the last few
 * entries are needed for the partial answer.
 */
export async function watchText(
  conversation: Conversation,
  listener: TextDeltaListener,
  options: WatchTextOptions = {},
): Promise<TextStream> {
  const watch = await conversation.watch(options.context ?? BACKGROUND_CONTEXT, { min: 1, max: 2 });

  let sent = 0;
  const deliver = async (text: string): Promise<void> => {
    if (text.length <= sent) return;
    const delta = text.slice(sent);
    sent = text.length;
    await listener(delta);
  };

  if (options.replay !== false) await deliver(liveGenerationText(watch.value));

  watch.start(async (call) => {
    if (call.kind !== "value") return;
    await deliver(liveGenerationText(call.value));
  });

  let stopping: Promise<void> | undefined;
  return {
    stop(): Promise<void> {
      stopping ??= watch.stop().then(
        () => undefined,
        () => undefined,
      );
      return stopping;
    },
  };
}

/**
 * K4/K5: stop the run in this conversation (and withdraw its queued inputs). The partial answer stays in
 * the transcript as a `pi.assistant` entry with `stopReason: "aborted"`; the submission settles
 * `unanswered` with reason `aborted`, which is what S2 turns into a `finish_reason`.
 */
export async function abortConversation(
  conversation: Conversation,
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
  await conversation.abort(context);
}
