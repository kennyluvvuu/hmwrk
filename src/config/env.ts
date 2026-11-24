/**
 * Environment variables and `.env` loading (SPEC §8 `src/config`, §9 deploy).
 *
 * The `.env` file is parsed by hand (~40 lines) instead of pulling in dotenv:
 * the format we actually use is `KEY=value`, comments and optional quotes.
 * Process environment always wins over the file, as with dotenv's default.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ConfigError, problemsFromZod } from "./errors";
import { LOG_LEVELS } from "./logger";

export type EnvSource = Record<string, string | undefined>;

/** Empty values (`KEY=`) behave as unset for optional settings. */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalSecret = () =>
  z.preprocess(emptyToUndefined, z.string().trim().min(1, "must not be empty").optional());

const requiredSecret = () => z.string({ error: "is required, but missing" }).trim().min(1, "must not be empty");

// Not strict: the process environment carries dozens of unrelated variables.
export const EnvSchema = z.object({
  PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number({ error: "must be a number" }).int("must be an integer").positive("must be positive").max(65535, "must be <= 65535").default(8787),
  ),
  DATA_DIR: z.string().trim().min(1, "must not be empty").default("./data"),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS, { error: `must be one of: ${LOG_LEVELS.join(", ")}` }).default("info")),

  GROQ_API_KEY: optionalSecret(),
  MISTRAL_API_KEY: optionalSecret(),
  TELEGRAM_BOT_TOKEN: optionalSecret(),

  // Role fallback (ADR 0004): two static keys, one per role, until OpenWebUI
  // user headers are confirmed at the M1 integration checkpoint.
  HMWRK_PARENT_KEY: requiredSecret(),
  HMWRK_CHILD_KEY: requiredSecret(),

  /** Absolute path to a models.json outside DATA_DIR. */
  MODELS_CONFIG: optionalSecret(),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

/** Validates an already merged key/value source. Does not touch the filesystem. */
export function parseEnv(source: EnvSource): EnvConfig {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError("Invalid environment variables", problemsFromZod(result.error));
  }
  return result.data;
}

/**
 * Reads a dotenv-style file. Lenient by design: unparseable lines are skipped,
 * `export KEY=...`, surrounding quotes, `#` comments and `\n` escapes are handled.
 */
export function parseDotenv(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) {
      const inner = value.slice(1, -1);
      value = value.startsWith('"') ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

/** Reads `.env` if present; a missing file is not an error. */
function readDotenvFile(path: string): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    return parseDotenv(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot read dotenv file ${path}: ${reason}`);
  }
}

export interface LoadEnvOptions {
  /** Explicit source instead of `process.env` (tests, embedders). */
  env?: EnvSource;
  /** Dotenv path; `false` disables reading a file. Default: `<cwd>/.env`. */
  dotenvPath?: string | false;
}

/** Merges `.env` (if any) with the process environment and validates the result. */
export function loadEnv(options: LoadEnvOptions = {}): EnvConfig {
  const dotenvPath = options.dotenvPath === undefined ? resolve(process.cwd(), ".env") : options.dotenvPath;
  const fromFile = dotenvPath === false ? {} : readDotenvFile(dotenvPath);
  const source: EnvSource = { ...fromFile, ...(options.env ?? process.env) };
  return parseEnv(source);
}
