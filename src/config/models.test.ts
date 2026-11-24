import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors";
import { loadModels, loadModelsFile, parseModels, resolveModelsPath } from "./models";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hmwrk-models-"));
}

function writeModels(dir: string, value: unknown): string {
  const path = join(dir, "models.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return path;
}

const valid = {
  read: { provider: "groq", modelId: "groq-vision-test" },
  verify: { provider: "mistral", modelId: "mistral-deepseek-test" },
  chat: { provider: "mistral", modelId: "mistral-deepseek-test" },
};

function capture(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected ConfigError");
}

describe("resolveModelsPath", () => {
  it("defaults to DATA_DIR/models.json and makes it absolute", () => {
    const path = resolveModelsPath({ dataDir: "/srv/hmwrk/data" });
    expect(path).toBe("/srv/hmwrk/data/models.json");
  });

  it("uses an absolute MODELS_CONFIG override", () => {
    expect(resolveModelsPath({ dataDir: "/srv/data", override: "/etc/hmwrk/models.json" })).toBe("/etc/hmwrk/models.json");
  });

  it("ignores an empty override", () => {
    expect(resolveModelsPath({ dataDir: "/srv/data", override: "  " })).toBe("/srv/data/models.json");
  });

  it("rejects a relative override with a MODELS_CONFIG problem", () => {
    const error = capture(() => resolveModelsPath({ dataDir: "/srv/data", override: "config/models.json" }));
    expect(error.problems).toEqual([
      { key: "MODELS_CONFIG", reason: 'must be an absolute path, got "config/models.json"' },
    ]);
  });
});

describe("loadModels", () => {
  it("reads models.json from DATA_DIR", () => {
    const dir = tempDir();
    writeModels(dir, valid);

    const models = loadModels({ dataDir: dir });

    expect(models.read).toEqual({ provider: "groq", modelId: "groq-vision-test" });
    expect(models.verify).toEqual({ provider: "mistral", modelId: "mistral-deepseek-test" });
    expect(models.chat).toEqual({ provider: "mistral", modelId: "mistral-deepseek-test" });
  });

  it("accepts the $comment placeholder field and trims model ids", () => {
    const dir = tempDir();
    writeModels(dir, { ...valid, $comment: "ids are placeholders", read: { provider: "groq", modelId: "  spaced  " } });

    const models = loadModels({ dataDir: dir });

    expect(models.$comment).toBe("ids are placeholders");
    expect(models.read.modelId).toBe("spaced");
  });

  it("fails with the resolved path when the file is missing", () => {
    const dir = tempDir();
    const error = capture(() => loadModels({ dataDir: dir }));

    expect(error.message).toContain(join(dir, "models.json"));
    expect(error.message).toContain("models.example.json");
  });

  it("fails with the resolved path when the JSON is broken", () => {
    const dir = tempDir();
    writeModels(dir, "{ not json ");

    const error = capture(() => loadModels({ dataDir: dir }));

    expect(error.format()).toContain("not valid JSON");
    expect(error.format()).toContain(join(dir, "models.json"));
  });

  it("loads an explicit file path regardless of DATA_DIR", () => {
    const dir = tempDir();
    const path = writeModels(dir, valid);

    expect(loadModelsFile(path).read.provider).toBe("groq");
  });
});

describe("parseModels", () => {
  it("reports a missing slot by name", () => {
    const error = capture(() => parseModels({ ...valid, chat: undefined }, "/etc/models.json"));

    expect(error.problems).toEqual([{ key: "chat", reason: "is required, but missing" }]);
    expect(error.format()).toContain("/etc/models.json");
  });

  it("rejects providers outside groq|mistral", () => {
    const error = capture(() => parseModels({ ...valid, read: { provider: "openai", modelId: "gpt" } }));

    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]?.key).toBe("read.provider");
    expect(error.problems[0]?.reason).toContain("groq");
  });

  it("rejects empty and unknown fields", () => {
    const error = capture(() =>
      parseModels({ ...valid, verify: { provider: "mistral", modelId: "  ", temperature: 0.2 } }),
    );

    const keys = error.problems.map((p) => p.key);
    expect(keys).toContain("verify.modelId");
    expect(keys).toContain("verify");
    const unknown = error.problems.find((p) => p.key === "verify");
    expect(unknown?.reason).toContain("temperature");
  });

  it("rejects a mistyped slot name", () => {
    const { read, ...rest } = valid;
    const error = capture(() => parseModels({ ...rest, reed: read }));

    expect(error.problems.map((p) => p.reason).join(" ")).toContain("reed");
  });
});
