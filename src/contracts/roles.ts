/**
 * Module contract: who is making the request (SPEC §4, ADR 0004), implemented by S2 in
 * `src/server/**` (the Hono middleware) on top of our `users` table.
 *
 * Two credential sources, tried in the order {@link ResolverMode} says:
 *
 * 1. **OpenWebUI user headers** — the primary mechanism once the integration checkpoint confirms
 *    them (`X-OpenWebUI-User-Id` and friends). The header names default to the next section and
 *    stay configurable, because "выбранный механизм фиксируем при первом подключении OpenWebUI".
 * 2. **Static role keys** — ADR 0004 fallback: two core API keys, one per role
 *    (`HMWRK_PARENT_KEY` / `HMWRK_CHILD_KEY`, already loaded by T2 into `Config.roles`).
 *
 * The contract is deliberately Hono-free: middleware adapts `c.req` to {@link AuthHeaders} and
 * maps {@link AuthResult} to a 401/403 JSON body. Nothing here performs I/O.
 */

import type { RoleKeys } from "../config/index.js";
import type { Role, UsersRepo } from "../domain/index.js";

// ---------------------------------------------------------------------------
// Input: the headers the middleware hands over
// ---------------------------------------------------------------------------

/**
 * Case-insensitive header lookup. `Headers` satisfies it directly; for Hono pass
 * `{ get: (name) => c.req.header(name) }`.
 */
export interface AuthHeaders {
  get(name: string): string | undefined;
}

/** Why the resolver was chosen; S2 logs it once at boot. */
export type ResolverMode =
  /** Only the two static keys are accepted (ADR 0004 fallback). */
  | "static-keys"
  /** Only OpenWebUI headers are trusted (M1 target if the checkpoint confirms them). */
  | "openwebui-headers"
  /** Headers first, static keys as a fallback for callers that send no user context. */
  | "hybrid";

/**
 * Header names carrying the OpenWebUI user context (SPEC §4). Defaults are OpenWebUI's own; the
 * resolver must treat them as untrusted configuration only after the M1 integration checkpoint,
 * because a public deployment that trusts arbitrary headers is an authorization bypass.
 */
export interface OpenWebUIHeaderNames {
  /** Default `"x-openwebui-user-id"`. Maps to `users.openwebui_user_id`. */
  readonly userId?: string;
  /** Default `"x-openwebui-user-email"`. Stored as a display hint only. */
  readonly email?: string;
  /** Default `"x-openwebui-user-name"`. Used when creating the `users` row. */
  readonly name?: string;
}

/** The endpoint of {@link UsersRepo} the resolver needs (domain contract from T1). */
export type UserDirectory = Pick<UsersRepo, "getByOpenWebUiId">;

// ---------------------------------------------------------------------------
// Output: the authenticated actor
// ---------------------------------------------------------------------------

/** Which credential proved the actor. */
export type AuthSource = "openwebui-headers" | "api-key";

/**
 * A resolved request actor.
 *
 * `userId` is the stable key the core owns: it names the durable conversation (K3) and is the
 * value S1 passes to `Core.getOrCreateConversation`. With OpenWebUI headers it is the
 * `users.id` row for `openwebui_user_id`; in static-key mode it is the synthetic, stable
 * `"key:parent"` / `"key:child"` (two accounts, ADR 0004), so keys and conversations stay 1:1
 * even before the `users` table is populated.
 */
export interface ResolvedActor {
  readonly userId: string;
  readonly role: Role;
  readonly via: AuthSource;
  /** `users.openwebui_user_id` when the headers carried one; absent in static-key mode. */
  readonly openwebuiUserId?: string;
  /** Display name when known (`users.name` or the name header). */
  readonly name?: string;
}

/** Why authentication failed; S2 renders it into the OpenAI-shaped error body. */
export type AuthErrorCode =
  /** No `Authorization` header, no user header, or a malformed `Bearer` value. */
  | "missing_credentials"
  /** A key or user header was sent but matches neither static key nor a `users` row. */
  | "invalid_credentials";

/** The failure, with the HTTP status the middleware should use. */
export interface AuthError {
  readonly code: AuthErrorCode;
  readonly message: string;
  /** `401` for both codes today; kept explicit so the middleware never invents one. */
  readonly httpStatus: 401 | 403;
}

/** Middleware-friendly result: either an actor or the reason there is none. */
export type AuthResult =
  | { readonly ok: true; readonly actor: ResolvedActor }
  | { readonly ok: false; readonly error: AuthError };

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/** Construction options; every field has a default except the keys. */
export interface RoleResolverOptions {
  /** Static per-role keys from `Config.roles` (ADR 0004). */
  readonly keys: RoleKeys;
  /** Default `"hybrid"`. */
  readonly mode?: ResolverMode;
  /** `users` directory; when absent, only static keys work (`mode` degrades to `static-keys`). */
  readonly users?: UserDirectory;
  /** Overrides of the OpenWebUI header names; see {@link OpenWebUIHeaderNames}. */
  readonly headerNames?: OpenWebUIHeaderNames;
  /** Header carrying the bearer token; default `"authorization"`. */
  readonly authorizationHeader?: string;
  /** Scheme expected before the static key; default `"Bearer"`. */
  readonly scheme?: string;
}

/**
 * Turns request headers into `{ userId, role }` (or `null`) plus an error for the 401 body.
 *
 * Implementations must be constant-time on key comparison and must not log credentials.
 */
export interface RoleResolver {
  readonly mode: ResolverMode;

  /** The role contract: the actor, or `null` when the request carries no usable credential. */
  resolve(headers: AuthHeaders): Promise<ResolvedActor | null>;

  /** Same lookup as {@link RoleResolver.resolve}, keeping the reason for the middleware. */
  authorize(headers: AuthHeaders): Promise<AuthResult>;
}

/** Build the resolver; S2 wires it into the Hono middleware. */
export function createRoleResolver(options: RoleResolverOptions): RoleResolver {
  throw new Error("Not implemented: contract only");
}
