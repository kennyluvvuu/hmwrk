import { describe, expect, it } from "vitest";
import type { AuthHeaders } from "../contracts/roles.js";
import { createInMemoryUsersRepo } from "../domain/index.js";
import { STATIC_ACTOR_IDS, createRoleResolver } from "./auth.js";

const keys = { parentKey: "parent-secret", childKey: "child-secret" };

/** Case-insensitive header lookup shaped like the middleware's adapter. */
function headers(init: Record<string, string> = {}): AuthHeaders {
  const map = new Headers(init);
  return { get: (name) => map.get(name) ?? undefined };
}

describe("createRoleResolver: static keys (ADR 0004 fallback)", () => {
  const resolver = createRoleResolver({ keys });

  it("degrades to static keys without a users directory", () => {
    expect(resolver.mode).toBe("static-keys");
  });

  it("rejects a request without credentials with a 401 body code", async () => {
    const result = await resolver.authorize(headers());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("missing_credentials");
    expect(result.error.httpStatus).toBe(401);
  });

  it("maps the parent key to the parent role and a stable actor id", async () => {
    const result = await resolver.authorize(headers({ authorization: `Bearer ${keys.parentKey}` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor).toEqual({
      userId: STATIC_ACTOR_IDS.parent,
      role: "parent",
      via: "api-key",
    });
  });

  it("maps the child key to the child role", async () => {
    const actor = await resolver.resolve(headers({ authorization: `Bearer ${keys.childKey}` }));
    expect(actor).toEqual({ userId: STATIC_ACTOR_IDS.child, role: "child", via: "api-key" });
  });

  it("rejects an unknown key as invalid (not missing) credentials", async () => {
    const result = await resolver.authorize(headers({ authorization: "Bearer nope" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_credentials");
  });

  it("treats a malformed Authorization value as missing credentials", async () => {
    for (const value of ["parent-secret", "Bearer", "Basic parent-secret"]) {
      const result = await resolver.authorize(headers({ authorization: value }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("missing_credentials");
    }
  });

  it("accepts a custom scheme and header name", async () => {
    const custom = createRoleResolver({
      keys,
      scheme: "Token",
      authorizationHeader: "x-api-key",
    });
    const actor = await custom.resolve(headers({ "x-api-key": `token ${keys.childKey}` }));
    expect(actor?.role).toBe("child");
  });

  it("returns null from resolve() when authorize() fails", async () => {
    expect(await resolver.resolve(headers({ authorization: "Bearer wrong" }))).toBeNull();
  });
});

describe("createRoleResolver: OpenWebUI headers (SPEC §4)", () => {
  async function usersFixture() {
    const users = createInMemoryUsersRepo();
    const parent = await users.create({ openwebui_user_id: "owui-parent", role: "parent", name: "Мама" });
    const child = await users.create({ openwebui_user_id: "owui-child", role: "child", name: "Сын" });
    return { users, parent, child };
  }

  it("maps a header to the users row, not to the shared key", async () => {
    const { users, child } = await usersFixture();
    const resolver = createRoleResolver({ keys, users });

    expect(resolver.mode).toBe("hybrid");
    const actor = await resolver.resolve(
      headers({ "x-openwebui-user-id": "owui-child", authorization: `Bearer ${keys.parentKey}` }),
    );
    expect(actor).toEqual({
      userId: child.id,
      role: "child",
      via: "openwebui-headers",
      openwebuiUserId: "owui-child",
      name: "Сын",
    });
  });

  it("falls back to the static key when no user header is sent", async () => {
    const { users } = await usersFixture();
    const resolver = createRoleResolver({ keys, users });
    const actor = await resolver.resolve(headers({ authorization: `Bearer ${keys.parentKey}` }));
    expect(actor?.via).toBe("api-key");
    expect(actor?.role).toBe("parent");
  });

  it("refuses an unmapped user instead of inheriting the key's role", async () => {
    const { users } = await usersFixture();
    const resolver = createRoleResolver({ keys, users });
    const result = await resolver.authorize(
      headers({ "x-openwebui-user-id": "owui-stranger", authorization: `Bearer ${keys.parentKey}` }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_credentials");
  });

  it("ignores headers entirely in openwebui-headers mode without a directory", () => {
    const resolver = createRoleResolver({ keys, users: undefined, mode: "openwebui-headers" });
    expect(resolver.mode).toBe("static-keys");
  });

  it("requires the user header in openwebui-headers mode", async () => {
    const { users } = await usersFixture();
    const resolver = createRoleResolver({ keys, users, mode: "openwebui-headers" });
    const result = await resolver.authorize(headers({ authorization: `Bearer ${keys.parentKey}` }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("missing_credentials");
  });
});
