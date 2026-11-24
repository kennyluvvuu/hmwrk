/**
 * Role resolution for the OpenAI-compatible server (S2). Contract: `src/contracts/roles.ts`.
 *
 * Two credential sources, tried in the order {@link ResolverMode} says (ADR 0004):
 *
 * 1. **OpenWebUI user headers** — primary once the M1 integration checkpoint confirms them.
 *    A header is only an *identity*, never an authority: the role is read from the `users` row
 *    (`users.openwebui_user_id → role`). Without that directory (M1, before D2 ships) headers are
 *    not trusted at all and the mode degrades to static keys.
 * 2. **Static role keys** — `HMWRK_PARENT_KEY` / `HMWRK_CHILD_KEY` (ADR 0004 fallback). Each key
 *    maps to a stable synthetic user id, so one key = one durable conversation.
 *
 * Rules:
 * - key comparison is constant-time (sha-256 digests + `timingSafeEqual`), never logged;
 * - a header that is present but unknown is an error, not a silent fall back to the shared key:
 *   otherwise any OpenWebUI account could inherit the key's role;
 * - an empty configured key never matches, even if env validation is bypassed.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { RoleKeys } from "../config/index.js";
import type { Role } from "../domain/index.js";
import type {
  AuthError,
  AuthErrorCode,
  AuthHeaders,
  AuthResult,
  OpenWebUIHeaderNames,
  ResolvedActor,
  ResolverMode,
  RoleResolver,
  RoleResolverOptions,
} from "../contracts/roles.js";

/** OpenWebUI's own header names (contract defaults, overridable through Config later). */
export const DEFAULT_HEADER_NAMES: Required<OpenWebUIHeaderNames> = {
  userId: "x-openwebui-user-id",
  email: "x-openwebui-user-email",
  name: "x-openwebui-user-name",
};

/**
 * Stable synthetic user ids of the two static keys (contract `ResolvedActor.userId`): the durable
 * conversation is named after the key, so keys and conversations stay 1:1 before `users` is filled.
 */
export const STATIC_ACTOR_IDS: Readonly<Record<Role, string>> = {
  parent: "key:parent",
  child: "key:child",
};

/** Default resolver mode when the caller does not care. */
const DEFAULT_MODE: ResolverMode = "hybrid";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time string comparison; hashing first hides both value and length from timing. */
function secretEquals(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  return timingSafeEqual(digest(a), digest(b));
}

function failure(code: AuthErrorCode, message: string): AuthResult {
  const error: AuthError = { code, message, httpStatus: 401 };
  return { ok: false, error };
}

/** Reads the first non-blank value of `name`; header lookup itself is case-insensitive. */
function readHeader(headers: AuthHeaders, name: string): string | undefined {
  const value = headers.get(name);
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** Splits `Authorization` into scheme + token without throwing on malformed values. */
function parseAuthorization(value: string): { scheme: string; token: string } | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [scheme, token] = parts as [string, string];
  if (token === "") return null;
  return { scheme: scheme.toLowerCase(), token };
}

/**
 * Builds the resolver the Hono auth middleware uses.
 *
 * `mode` degrades to `static-keys` when no `users` directory is supplied (contract), because
 * header identity is unusable without the role table.
 */
export function createRoleResolver(options: RoleResolverOptions): RoleResolver {
  const keys: RoleKeys = options.keys;
  const users = options.users;
  const requestedMode: ResolverMode = options.mode ?? DEFAULT_MODE;
  const mode: ResolverMode = users === undefined ? "static-keys" : requestedMode;
  const headerNames: Required<OpenWebUIHeaderNames> = { ...DEFAULT_HEADER_NAMES, ...options.headerNames };
  const authorizationHeader = (options.authorizationHeader ?? "authorization").toLowerCase();
  const scheme = (options.scheme ?? "Bearer").toLowerCase();

  /** Header identity → `users` row → role. Returns `undefined` when no header was sent. */
  async function actorFromHeaders(
    headers: AuthHeaders,
    directory: NonNullable<RoleResolverOptions["users"]>,
  ): Promise<AuthResult | undefined> {
    const openwebuiUserId = readHeader(headers, headerNames.userId);
    if (openwebuiUserId === undefined) return undefined;
    const user = await directory.getByOpenWebUiId(openwebuiUserId);
    if (user === null) {
      return failure(
        "invalid_credentials",
        `OpenWebUI user ${openwebuiUserId} is not mapped to a role; add it to the users table`,
      );
    }
    const actor: ResolvedActor = {
      userId: user.id,
      role: user.role,
      via: "openwebui-headers",
      openwebuiUserId: user.openwebui_user_id,
      name: readHeader(headers, headerNames.name) ?? user.name,
    };
    return { ok: true, actor };
  }

  /** Static key → synthetic actor. */
  function actorFromApiKey(headers: AuthHeaders): AuthResult {
    const raw = headers.get(authorizationHeader);
    if (raw === undefined || raw.trim() === "") {
      return failure("missing_credentials", "Missing Authorization header (bearer API key)");
    }
    const parsed = parseAuthorization(raw);
    if (parsed === null || parsed.scheme !== scheme) {
      // Contract: a malformed Bearer value counts as *missing* credentials, not a bad one.
      return failure("missing_credentials", `Authorization must be "${scheme} <api-key>"`);
    }
    // Compare both keys unconditionally so the answer does not depend on which one matched first.
    const parent = secretEquals(parsed.token, keys.parentKey);
    const child = secretEquals(parsed.token, keys.childKey);
    if (!parent && !child) {
      return failure("invalid_credentials", "Unknown API key");
    }
    // Two identical keys are a config error; the parent role wins deterministically.
    const role: Role = parent ? "parent" : "child";
    return {
      ok: true,
      actor: { userId: STATIC_ACTOR_IDS[role], role, via: "api-key" },
    };
  }

  async function authorize(headers: AuthHeaders): Promise<AuthResult> {
    if (users !== undefined && (mode === "openwebui-headers" || mode === "hybrid")) {
      const fromHeaders = await actorFromHeaders(headers, users);
      if (fromHeaders !== undefined) return fromHeaders;
    }
    if (mode === "openwebui-headers") {
      return failure("missing_credentials", `Missing ${headerNames.userId} header`);
    }
    return actorFromApiKey(headers);
  }

  return {
    mode,
    async resolve(headers: AuthHeaders): Promise<ResolvedActor | null> {
      const result = await authorize(headers);
      return result.ok ? result.actor : null;
    },
    authorize,
  };
}
