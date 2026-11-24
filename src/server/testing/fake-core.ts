/**
 * In-memory stand-in for the slice of `Core` the HTTP layer uses (see `ServerCore` in
 * `../routes.ts`). It implements the *contract* — conversations are created once per user id,
 * echoes are recorded per conversation — without a harness, a database or a model, which is what
 * lets the route tests run in the sandbox (no `listen`, no SQLite).
 *
 * The real `Core` (S1) satisfies `ServerCore` structurally; the rest of its surface (`harness`,
 * `db`, `storage`, `actors`, …) is not touched by the server and is therefore absent here.
 */
import type { ConversationId, EntryId, UserInput } from "@earendil-works/pi-durable";
import type { CoreConversation, EchoOptions, EchoTurn } from "../../contracts/harness.js";
import type { Role } from "../../domain/index.js";
import type { ServerCore } from "../routes.js";

/** One recorded echo call, for asserting which conversation answered. */
export interface RecordedEcho {
  readonly conversationId: ConversationId;
  readonly userId: string;
  readonly role: Role;
  readonly text: string;
  readonly input: UserInput;
  readonly requestId?: string;
}

export interface FakeCore extends ServerCore {
  /** `userId` → conversation, exactly like the durable mapping (K3). */
  readonly conversations: Map<string, CoreConversation>;
  readonly echoes: RecordedEcho[];
  readonly calls: { getOrCreateConversation: number; echo: number };
  /** Number of distinct conversations created so far. */
  conversationCount(): number;
}

export interface FakeCoreOptions {
  /** Overrides the first conversation id (default 1). */
  readonly firstConversationId?: number;
}

export function createFakeCore(options: FakeCoreOptions = {}): FakeCore {
  let nextConversationId = options.firstConversationId ?? 1;
  let nextEntryId = 1;
  const conversations = new Map<string, CoreConversation>();
  const echoes: RecordedEcho[] = [];
  const calls = { getOrCreateConversation: 0, echo: 0 };

  return {
    conversations,
    echoes,
    calls,
    conversationCount: () => conversations.size,

    async getOrCreateConversation(userId: string, role: Role): Promise<CoreConversation> {
      calls.getOrCreateConversation += 1;
      const known = conversations.get(userId);
      if (known !== undefined) return known;
      const created: CoreConversation = {
        id: nextConversationId++ as ConversationId,
        userId,
        role,
        // pi-durable's `Conversation` handle; the HTTP layer never dereferences it.
        handle: undefined as never,
      };
      conversations.set(userId, created);
      return created;
    },

    async echo(conversation: CoreConversation, text: string, echoOptions?: EchoOptions): Promise<EchoTurn> {
      calls.echo += 1;
      echoes.push({
        conversationId: conversation.id,
        userId: conversation.userId,
        role: conversation.role,
        text,
        input: text,
        ...(echoOptions?.requestId === undefined ? {} : { requestId: echoOptions.requestId }),
      });
      return {
        conversationId: conversation.id,
        userEntryId: nextEntryId++ as EntryId,
        assistantEntryId: nextEntryId++ as EntryId,
        text,
      };
    },
  };
}
