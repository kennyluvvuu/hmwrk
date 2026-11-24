/**
 * Chat binding logic behind `scripts/bind-telegram.ts` (SPEC §5.6 `tg_bindings`).
 *
 * The CLI is the only supported way to bind a chat in the MVP: OpenWebUI login creates the
 * `users` row, and an operator (the parent) then says once «этот чат принадлежит роли X».
 * There is deliberately no in-chat `/start` flow — the bot never reads updates (only
 * `sendMessage`), so it cannot learn a chat id by itself.
 *
 * Kept separate from the script so tests can drive it against an in-memory repository and the
 * script stays a thin argument/env wrapper.
 */

import { DomainError } from "../domain/errors.js";
import type { Repos } from "../domain/repo.js";
import type { Role, TgBinding } from "../domain/types.js";

/** What the operator asks for: «этот chat_id — родитель (или ребёнок)». */
export interface BindRoleChatInput {
  readonly role: Role;
  readonly chatId: string;
}

/** Result of a successful bind, printed by the CLI. */
export interface BindRoleChatResult {
  readonly binding: TgBinding;
  readonly userName: string;
  readonly openwebuiUserId: string;
}

/** Numeric id (groups are negative) or `@channelname`, as the Bot API accepts it. */
const CHAT_ID_PATTERN = /^-?\d+$|^@[A-Za-z][A-Za-z0-9_]{3,}$/;

/** Parses the CLI roles strictly: a typo must fail, not bind the wrong person. */
export function parseRole(value: string): Role {
  if (value !== "parent" && value !== "child") {
    throw new DomainError("invalid_argument", `role must be "parent" or "child", got "${value}"`);
  }
  return value;
}

/** Validates a chat id before it ever reaches the database. */
export function parseChatId(value: string): string {
  const chatId = value.trim();
  if (!CHAT_ID_PATTERN.test(chatId)) {
    throw new DomainError(
      "invalid_argument",
      `chat id must be numeric (groups are negative) or @channelname, got "${value}"`,
    );
  }
  return chatId;
}

/**
 * Bind `chatId` to the user of `role`.
 *
 * The MVP has exactly one user per role (SPEC §4), so zero or several candidates are both an
 * error: binding «the first one» would silently send a child's reminders to a second account.
 * The message tells the operator what to do instead (log in once, then retry).
 */
export async function bindRoleChat(
  repos: Pick<Repos, "users" | "tgBindings">,
  input: BindRoleChatInput,
): Promise<BindRoleChatResult> {
  const role = parseRole(input.role);
  const chatId = parseChatId(input.chatId);

  const users = await repos.users.listByRole(role);
  const [user] = users;
  if (user === undefined) {
    throw new DomainError(
      "not_found",
      `no user with role "${role}": log in to OpenWebUI with the ${role} account (or send one request with the ${role} API key) so the users row exists, then retry`,
    );
  }
  if (users.length > 1) {
    const names = users.map((candidate) => `${candidate.name} <${candidate.openwebui_user_id}>`).join(", ");
    throw new DomainError(
      "conflict",
      `${users.length} users have role "${role}" (${names}); the MVP expects one user per role, fix the roles first`,
    );
  }

  const binding = await repos.tgBindings.upsert({ user_id: user.id, chat_id: chatId });
  return { binding, userName: user.name, openwebuiUserId: user.openwebui_user_id };
}
