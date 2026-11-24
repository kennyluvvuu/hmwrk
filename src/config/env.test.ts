import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors";
import { loadEnv, parseDotenv, parseEnv } from "./env";

const required = { HMWRK_PARENT_KEY: "parent-secret", HMWRK_CHILD_KEY: "child-secret" };

describe("parseEnv", () => {
  it("applies defaults and leaves optional secrets absent", () => {
    const env = parseEnv(required);

    expect(env.PORT).toBe(8787);
    expect(env.DATA_DIR).toBe("./data");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.MISTRAL_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.MODELS_CONFIG).toBeUndefined();
  });

  it("reads explicit values and coerces PORT from its string form", () => {
    const env = parseEnv({
      ...required,
      PORT: "3000",
      DATA_DIR: " /srv/hmwrk ",
      LOG_LEVEL: "debug",
      GROQ_API_KEY: "gsk_test",
      MISTRAL_API_KEY: "ms_test",
      TELEGRAM_BOT_TOKEN: "123:abc",
    });

    expect(env.PORT).toBe(3000);
    expect(env.DATA_DIR).toBe("/srv/hmwrk");
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.GROQ_API_KEY).toBe("gsk_test");
    expect(env.MISTRAL_API_KEY).toBe("ms_test");
    expect(env.TELEGRAM_BOT_TOKEN).toBe("123:abc");
  });

  it("treats empty optional variables as unset", () => {
    const env = parseEnv({ ...required, GROQ_API_KEY: "", MISTRAL_API_KEY: "   ", PORT: "" });

    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.MISTRAL_API_KEY).toBeUndefined();
    expect(env.PORT).toBe(8787);
  });

  it("ignores unrelated environment variables", () => {
    const env = parseEnv({ ...required, PATH: "/usr/bin", HOME: "/root" });
    expect(env.PORT).toBe(8787);
  });

  it.each(["HMWRK_PARENT_KEY", "HMWRK_CHILD_KEY"])("reports the missing required key %s by name", (key) => {
    const source: Record<string, string | undefined> = { ...required };
    delete source[key];

    let error: unknown;
    try {
      parseEnv(source);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.problems.map((p) => p.key)).toContain(key);
    expect(configError.format()).toContain(key);
  });

  it("rejects an empty required key with a readable message", () => {
    expect(() => parseEnv({ ...required, HMWRK_PARENT_KEY: "  " })).toThrow(ConfigError);
    try {
      parseEnv({ ...required, HMWRK_PARENT_KEY: "  " });
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.format()).toContain("HMWRK_PARENT_KEY: must not be empty");
    }
  });

  it("names the variable and the reason for a bad PORT and LOG_LEVEL", () => {
    try {
      parseEnv({ ...required, PORT: "eighty", LOG_LEVEL: "loud" });
      expect.unreachable("parseEnv should throw");
    } catch (error) {
      const configError = error as ConfigError;
      const keys = configError.problems.map((p) => p.key);
      expect(keys).toEqual(["PORT", "LOG_LEVEL"]);
      expect(configError.format()).toContain("LOG_LEVEL:");
      expect(configError.format()).toMatch(/PORT: .*number/);
    }
  });
});

describe("parseDotenv", () => {
  it("parses assignments, comments, quotes and export prefixes", () => {
    const parsed = parseDotenv(
      [
        "# leading comment",
        "",
        "PORT=3000",
        "DATA_DIR=./data",
        'GROQ_API_KEY="quoted value"',
        "MISTRAL_API_KEY='single quoted'",
        "export TELEGRAM_BOT_TOKEN=123:abc",
        "HMWRK_PARENT_KEY=parent # inline comment",
        "HMWRK_CHILD_KEY=child-secret",
        "  # indented comment",
        "not an assignment",
        "1INVALID=x",
        "JSON_ESCAPE=\"line1\\nline2\"",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      PORT: "3000",
      DATA_DIR: "./data",
      GROQ_API_KEY: "quoted value",
      MISTRAL_API_KEY: "single quoted",
      TELEGRAM_BOT_TOKEN: "123:abc",
      HMWRK_PARENT_KEY: "parent",
      HMWRK_CHILD_KEY: "child-secret",
      JSON_ESCAPE: "line1\nline2",
    });
  });

  it("keeps empty values (the env schema decides what they mean)", () => {
    expect(parseDotenv("GROQ_API_KEY=\n")).toEqual({ GROQ_API_KEY: "" });
  });
});

describe("loadEnv", () => {
  const dir = mkdtempSync(join(tmpdir(), "hmwrk-env-"));

  it("loads a dotenv file and lets the process environment win", () => {
    const path = join(dir, "with-file.env");
    writeFileSync(path, ["PORT=4000", "DATA_DIR=/from/file", "HMWRK_PARENT_KEY=from-file", "HMWRK_CHILD_KEY=child"].join("\n"));

    const env = loadEnv({ dotenvPath: path, env: { HMWRK_PARENT_KEY: "from-process", PORT: "5000" } });

    expect(env.PORT).toBe(5000);
    expect(env.DATA_DIR).toBe("/from/file");
    expect(env.HMWRK_PARENT_KEY).toBe("from-process");
    expect(env.HMWRK_CHILD_KEY).toBe("child");
  });

  it("does not require a dotenv file", () => {
    const env = loadEnv({ dotenvPath: join(dir, "missing.env"), env: required });
    expect(env.PORT).toBe(8787);
  });

  it("skips the file entirely when dotenvPath is false", () => {
    const env = loadEnv({ dotenvPath: false, env: required });
    expect(env.DATA_DIR).toBe("./data");
  });
});
