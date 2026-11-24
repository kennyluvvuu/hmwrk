/**
 * Chat-id resolution over `tg_bindings` (SPEC §5.6 `tg_bindings`, T1 `TgBindingsRepo`).
 *
 * The notification tasks never guess a chat: they ask `repos.users` for the role's users and
 * this module for the bound chats. Two shapes, because N1 needs both:
 *
 * - {@link resolveUserChatId} — one chat (or `null`), e.g. «чья привязка отвечает за ребёнка»;
 * - {@link resolveUserChats} — every binding found, e.g. a digest to all parents of the family.
 *
 * Order follows the given user list, which is the repository order (ascending `created_at`), so a
 * single-user family behaves as before and a second parent is appended rather than shuffled.
 *
 * `escapeHtml` lives here too: templates in `./templates.ts` are sent with
 * `parse_mode: "HTML"`, so every *data* string must be escaped exactly once, at render time.
 */

import type { TgBindingsRepo } from "../domain/repo.js";
import type { Id, TgBinding, User } from "../domain/types.js";

/** The part of {@link TgBindingsRepo} this module needs (accepts fakes and SQLite alike). */
export type ChatBindingLookup = Pick<TgBindingsRepo, "getByUserId">;

/**
 * Telegram's HTML parse mode escapes three characters and nothing else. `"` and `'` are only
 * special inside attribute values, which the templates never build from user data.
 *
 * `&` must be replaced first — otherwise `&lt;` would become `&amp;lt;`.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One user and the chat they are bound to. */
export interface UserChat {
  readonly userId: Id;
  readonly chatId: string;
}

/** Chat of the first user in `users` that has a binding; `null` when none is bound. */
export async function resolveUserChatId(bindings: ChatBindingLookup, users: readonly User[]): Promise<string | null> {
  for (const user of users) {
    const binding = await bindings.getByUserId(user.id);
    if (binding !== null) return binding.chat_id;
  }
  return null;
}

/** Every binding found for `users`, in the given order. */
export async function resolveUserChats(bindings: ChatBindingLookup, users: readonly User[]): Promise<UserChat[]> {
  const chats: UserChat[] = [];
  for (const user of users) {
    const binding = await bindings.getByUserId(user.id);
    if (binding !== null) chats.push({ userId: user.id, chatId: binding.chat_id });
  }
  return chats;
}

/** `TgBinding[]` → bare chat ids (deduplicated, order kept). Convenience for broadcast loops. */
export function chatIdsOf(bindings: readonly TgBinding[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const binding of bindings) {
    if (seen.has(binding.chat_id)) continue;
    seen.add(binding.chat_id);
    ids.push(binding.chat_id);
  }
  return ids;
}
