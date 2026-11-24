/**
 * K3: the user ↔ durable-conversation mapping that pi-durable does not have.
 *
 * `ConversationQuery` filters by owner conversation or owner task only, so "which conversation belongs to
 * `key:parent`?" is our own index. It lives in a *session document* (`app.user-conversations`) written in
 * the same commit that creates the conversation: either both exist or neither does, and it survives a
 * restart for free (R1 K3 pattern, verified against a real SQLite file).
 *
 * The document holds both directions:
 * - `byUser`: our actor id → conversation id (lookup by request),
 * - `actors`: conversation id → actor id + role (the reverse direction A1's prompt section needs, since a
 *   `PromptInput` carries only `conversationId`).
 *
 * Nothing here talks to `src/server` or `src/agent`; both see `CoreConversation` / `ActorDirectory`.
 */

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, ModelRef } from "@earendil-works/pi-durable";
import { configure, defineDoc } from "@earendil-works/pi-durable";
import type { ModelSlot } from "../config/index.js";
import {
  USER_CONVERSATIONS_DOC_KIND,
  type ActorDirectory,
  type ActorRecord,
  type CoreConversation,
  type HarnessConfig,
  type UserConversationIndex,
} from "../contracts/harness.js";
import type { Role } from "../domain/index.js";

/**
 * Local JSON shape of the mapping document. It mirrors {@link UserConversationIndex} but is written as
 * type aliases: `defineDoc<T extends JsonObject>` needs implicit index signatures, which interfaces do not
 * have. Converted at the boundary, so the persisted and the published shapes stay identical.
 */
type ActorRecordValue = { userId: string; role: Role };

type UserConversationIndexValue = {
  byUser: Record<string, number>;
  actors: Record<string, ActorRecordValue>;
};

/** K3: the session document itself; exported for tests and for the M2 follow-up sweeps. */
export const UserConversationsDoc = defineDoc<UserConversationIndexValue>({
  kind: USER_CONVERSATIONS_DOC_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ byUser: {}, actors: {} }),
  // The index is small and random-access: base snapshots would only rewrite it; deltas are enough.
  checkpointWhen: () => false,
});

/** What the mapping looks like before the first conversation exists. */
export function emptyUserConversationIndex(): UserConversationIndex {
  return { byUser: {}, actors: {} };
}

/** Reads the mapping document; absent storage document → the empty index. */
export async function readUserConversationIndex(
  harness: Harness,
  context: Context = BACKGROUND_CONTEXT,
): Promise<UserConversationIndex> {
  return (await harness.snapshot(UserConversationsDoc, context)) ?? emptyUserConversationIndex();
}

/**
 * Subset of {@link HarnessConfig} a conversation needs: the model slot configured on a fresh
 * conversation. `chat` is the conversational slot of SPEC §7; changing it in models.json changes future
 * conversations, existing ones keep the model they were configured with (pi-durable stores the ref).
 */
export function conversationModelRef(cfg: Pick<HarnessConfig, "models">, slot: ModelSlot = "chat"): ModelRef {
  const ref = cfg.models[slot];
  return { provider: ref.provider, modelId: ref.modelId };
}

/** What the conversation functions need from the open core. */
export interface ConversationDeps {
  readonly harness: Harness;
  /** Model configured into a freshly created conversation (K3 gotcha: without it, runs fail `no_model`). */
  readonly chatModel: ModelRef;
  /** Default invocation context for the commits below. */
  readonly context?: Context;
}

/** K3: the read side of the mapping, as `Core.actors`. */
export function createActorDirectory(
  harness: Harness,
  context: Context = BACKGROUND_CONTEXT,
): ActorDirectory {
  return {
    async get(conversationId: ConversationId): Promise<ActorRecord | null> {
      const index = await readUserConversationIndex(harness, context);
      const actor = index.actors[String(conversationId)];
      return actor === undefined ? null : { userId: actor.userId, role: actor.role };
    },
  };
}

/**
 * K3: the conversation of `userId`, created on first use.
 *
 * Creation, the model `configure()` and the mapping write are one commit: a crash between them can not
 * leave a conversation nobody can find, nor a mapping to a conversation that does not exist. A repeated
 * call for a known user writes nothing (unless the role changed) and returns the same conversation.
 *
 * Two users never share a conversation, and a parent's conversation is as independent as a child's: the
 * role is metadata in our index, not a property of the durable conversation.
 */
export async function getOrCreateConversation(
  deps: ConversationDeps,
  userId: string,
  role: Role,
): Promise<CoreConversation> {
  const context = deps.context ?? BACKGROUND_CONTEXT;
  const actor: ActorRecordValue = { userId, role };

  const conversationId = await deps.harness.commit(async (tx) => {
    const index = await tx.doc(UserConversationsDoc);
    const known = index.byUser[userId];
    if (known !== undefined) {
      const stored = index.actors[String(known)];
      if (stored === undefined || stored.role !== role || stored.userId !== userId) {
        index.actors[String(known)] = actor;
      }
      // No table write: a commit that only read the happy path stores nothing.
      return known as ConversationId;
    }

    const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
    // A conversation created without a model fails every run with `no_model` (R1 K3), so this is not optional.
    await configure(tx, created.id, { model: deps.chatModel });
    index.byUser[userId] = created.id;
    index.actors[String(created.id)] = actor;
    return created.id;
  }, context);

  const handle = await deps.harness.conversation(conversationId, context);
  if (handle === undefined) {
    throw new Error(`durable conversation ${conversationId} vanished right after its commit`);
  }
  return { id: handle.id, userId, role, handle };
}

/** K3: mapping lookup only; `null` when this user has no conversation (or the mapping is incomplete). */
export async function conversationByUser(
  deps: Pick<ConversationDeps, "harness" | "context">,
  userId: string,
): Promise<CoreConversation | null> {
  const context = deps.context ?? BACKGROUND_CONTEXT;
  const index = await readUserConversationIndex(deps.harness, context);
  const known = index.byUser[userId];
  if (known === undefined) return null;

  const actor = index.actors[String(known)];
  if (actor === undefined) return null;

  const handle: Conversation | undefined = await deps.harness.conversation(known as ConversationId, context);
  if (handle === undefined) return null;

  return { id: handle.id, userId: actor.userId, role: actor.role, handle };
}
