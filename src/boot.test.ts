/**
 * Boot wiring (I2): what `createHmwrkApp` must have done before the first request is served.
 *
 * This replaces the M1 smoke test («the packages import») with the three things the M2 brief asks
 * boot to guarantee:
 *
 * 1. the domain schema is migrated at start (D2) — a repository call must work immediately;
 * 2. roles resolve in `hybrid` mode: an OpenWebUI user header + a `users` row wins, a static key
 *    still works for a caller that sends no user context (ADR 0004);
 * 3. the system prompt carries the SPEC §6 summary of active assignments, rendered by the real
 *    extension through the real registry (not by calling the renderer with a hand-made context).
 *
 * A faux `Models` collection keeps the test offline/keys-free; nothing here calls a provider.
 */

import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptInput } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmwrkApp, type HmwrkApp } from "./app.js";
import type { Config } from "./config/index.js";
import { registryFor } from "./durable/index.js";
import { makeTempDir, silentLogger, type TempDir } from "./durable/testkit.js";
import { buildFauxLlm } from "./faux.js";
import { AGENT_EXTENSION_NAME } from "./contracts/index.js";
import { AGENT_SECTION_KEY_INSTALLED } from "./agent/index.js";

const KEYS = { parentKey: "parent-secret", childKey: "child-secret" };
const OPENWEBUI_ID = "owui-42";

/** A complete `Config` for a scratch directory (no env file, no models.json read). */
function testConfig(dataDir: string): Config {
  return {
    port: 0,
    dataDir,
    photosDir: join(dataDir, "photos"),
    dbPath: join(dataDir, "hmwrk.sqlite"),
    logLevel: "error",
    echo: false,
    faux: { enabled: false },
    models: {
      read: { provider: "groq", modelId: "qwen/qwen3.6-27b" },
      verify: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
      chat: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
    },
    modelsPath: join(dataDir, "models.json"),
    secrets: {},
    roles: KEYS,
  };
}

let temp: TempDir;
let app: HmwrkApp;

beforeAll(async () => {
  temp = makeTempDir("hmwrk-boot-");
  app = await createHmwrkApp({
    config: testConfig(temp.dir),
    llm: buildFauxLlm(),
    logger: silentLogger(),
    now: () => new Date("2026-11-24T09:00:00.000Z"),
  });
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  temp?.remove();
});

describe("boot: domain", () => {
  it("applies the migrations before the app is handed out", async () => {
    expect(await app.domain.version()).toBeGreaterThanOrEqual(1);
    // The repositories are usable immediately: an un-migrated file throws here.
    await expect(app.domain.repos.assignments.list()).resolves.toEqual([]);
    await expect(app.domain.repos.settings.getAll()).resolves.toBeTruthy();
  });

  it("puts the durable and the domain tables in one SQLite file (K2)", async () => {
    const rows = await app.core.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = rows.map((row) => row.name);
    expect(names).toContain("pi_conversations");
    expect(names).toContain("assignments");
  });
});

describe("boot: roles (ADR 0004 hybrid)", () => {
  it("resolves an OpenWebUI user through the users table", async () => {
    const user = await app.domain.repos.users.create({
      openwebui_user_id: OPENWEBUI_ID,
      role: "parent",
      name: "Мама",
    });

    const result = await app.resolver.authorize({
      get: (name) => (name.toLowerCase() === "x-openwebui-user-id" ? OPENWEBUI_ID : undefined),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.actor).toMatchObject({ userId: user.id, role: "parent", via: "openwebui-headers" });
    // The resolver only reports the mode it can do: a users directory means hybrid, not static-only.
    expect(app.resolver.mode).toBe("hybrid");
  });

  it("falls back to static keys when no user header is sent", async () => {
    const result = await app.resolver.authorize({
      get: (name) => (name.toLowerCase() === "authorization" ? `Bearer ${KEYS.childKey}` : undefined),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.actor).toMatchObject({ userId: "key:child", role: "child", via: "api-key" });
  });

  it("refuses an unknown OpenWebUI user instead of inheriting a key's role", async () => {
    const result = await app.resolver.authorize({
      get: (name) => (name.toLowerCase() === "x-openwebui-user-id" ? "owui-unknown" : undefined),
    });
    expect(result.ok).toBe(false);
  });
});

describe("boot: agent", () => {
  it("installs the nine tools and the verify task", () => {
    const snapshot = registryFor(app.core).snapshot();
    expect(snapshot.tools().map((entry) => entry.tool.name).sort()).toEqual(
      [
        "approve_verification",
        "dismiss_verification",
        "get_settings",
        "get_verdicts",
        "list_assignments",
        "manual_add_assignment",
        "parse_screenshot",
        "set_setting",
        "submit_check_in",
      ].sort(),
    );
    // The spawner resolves the task from the registry, so a registered task proves the install order.
    expect(snapshot.task("hmwrk.verify")).toBeDefined();
  });

  it("renders the active-assignments summary into the system prompt (SPEC §6)", async () => {
    await app.domain.repos.assignments.create({
      subject: "География",
      due_at: "2026-11-25T17:00:00.000Z",
      source: "manual",
      items: [{ label: "№ 3" }],
    });

    const conversation = await app.core.getOrCreateConversation("key:parent", "parent");
    const extension = registryFor(app.core).snapshot().extension(AGENT_EXTENSION_NAME);
    expect(extension?.sections?.[0]?.key).toBe(AGENT_SECTION_KEY_INSTALLED);

    const section = extension?.sections?.[0];
    if (section === undefined) throw new Error("the hmwrk prompt section is not installed");
    const prompt = await section.render(
      { conversationId: conversation.id } as unknown as PromptInput,
      BACKGROUND_CONTEXT,
    );

    expect(prompt).toContain("География");
    // The prompt formats the due instant in the household timezone, so only the shape is asserted.
    expect(prompt).toMatch(/\d{2}\.\d{2}\.\d{4} — География — ждёт отчёта/);
    // M2: the prompt claims the tools, not the M1 «skeleton» wording.
    expect(prompt).toContain("manual_add_assignment");
    expect(prompt).not.toContain("Доменных инструментов у тебя пока нет");
  });
});
