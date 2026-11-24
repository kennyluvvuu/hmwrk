import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors";
import { loadConfig } from "./index";
import type { EnvSource } from "./env";

const models = {
  read: { provider: "groq", modelId: "groq-vision-test" },
  verify: { provider: "mistral", modelId: "mistral-deepseek-test" },
  chat: { provider: "mistral", modelId: "mistral-deepseek-test" },
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hmwrk-config-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify(models));
  const env: EnvSource = {
    HMWRK_PARENT_KEY: "parent-secret",
    HMWRK_CHILD_KEY: "child-secret",
    DATA_DIR: dir,
    LOG_LEVEL: "warn",
    GROQ_API_KEY: "gsk_test",
  };
  return { dir, modelsPath, env };
}

describe("loadConfig", () => {
  it("assembles env, model slots and paths", () => {
    const { dir, env } = setup();

    const config = loadConfig({ env, dotenvPath: false });

    expect(config.port).toBe(8787);
    expect(config.dataDir).toBe(resolve(dir));
    expect(config.photosDir).toBe(join(resolve(dir), "photos"));
    expect(config.dbPath).toBe(join(resolve(dir), "hmwrk.sqlite"));
    expect(config.logLevel).toBe("warn");
    expect(config.models.verify.provider).toBe("mistral");
    expect(config.modelsPath).toBe(join(resolve(dir), "models.json"));
    expect(config.secrets).toEqual({
      groqApiKey: "gsk_test",
      mistralApiKey: undefined,
      telegramBotToken: undefined,
    });
    expect(config.roles).toEqual({ parentKey: "parent-secret", childKey: "child-secret" });
  });

  it("honours an explicit modelsPath option", () => {
    const { modelsPath, env } = setup();

    const config = loadConfig({ env, dotenvPath: false, modelsPath });

    expect(config.models.read.modelId).toBe("groq-vision-test");
  });

  it("honours an absolute MODELS_CONFIG", () => {
    const { modelsPath, env } = setup();

    const config = loadConfig({ env: { ...env, MODELS_CONFIG: modelsPath }, dotenvPath: false });

    expect(config.modelsPath).toBe(modelsPath);
  });

  it("fails on environment problems before touching models.json", () => {
    const { env } = setup();
    delete env["HMWRK_CHILD_KEY"];

    expect(() => loadConfig({ env, dotenvPath: false })).toThrow(ConfigError);
  });
});
