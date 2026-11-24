/**
 * Test-only helpers for `src/durable/*.test.ts` (not a test file itself).
 *
 * The generation tests never call a real provider: they build a `Models` collection holding pi-ai's faux
 * provider (R1 K6) and pass it through `OpenHarnessOptions.models`. The faux provider is registered under
 * the *contract* provider id of the `chat` slot, so the conversation's configured `ModelRef` resolves to
 * the scripted model without any production-side test hook.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  type FauxProviderHandle,
  type Models,
} from "@earendil-works/pi-ai";
import { createLogger, type Logger } from "../config/logger.js";
import type { HarnessConfig } from "../contracts/harness.js";

/** The `chat` slot of `models.example.json`; the faux provider is registered as this provider/model pair. */
export const TEST_CHAT_MODEL = { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" } as const;

export interface FakeProviders {
  readonly models: Models;
  readonly faux: FauxProviderHandle;
}

/** A `Models` collection with only the scripted faux provider, registered under the chat slot's ids. */
export function fauxModels(options?: Parameters<typeof fauxProvider>[0]): FakeProviders {
  const faux = fauxProvider({
    provider: TEST_CHAT_MODEL.provider,
    models: [{ id: TEST_CHAT_MODEL.modelId }],
    ...options,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

/** A config for a temp directory: every slot points at the two providers SPEC §7 names. */
export function testConfig(dataDir: string): HarnessConfig {
  return {
    dbPath: join(dataDir, "hmwrk.sqlite"),
    dataDir,
    models: {
      read: { provider: "groq", modelId: "qwen/qwen3.8-27b" },
      verify: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
      chat: { provider: TEST_CHAT_MODEL.provider, modelId: TEST_CHAT_MODEL.modelId },
    },
  };
}

/** A logger that keeps test output clean but can still be inspected when a test fails. */
export function silentLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (line) => lines.push(line),
    bindings: { module: "durable-test" },
  });
  return Object.assign(logger, { lines });
}

export interface TempDir {
  readonly dir: string;
  remove(): void;
}

/** A scratch directory under the session's `$TMPDIR` (never the project, never a fixed path). */
export function makeTempDir(prefix = "hmwrk-durable-"): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
