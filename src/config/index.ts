/**
 * Single entry point for configuration: environment + model slots + paths.
 * Everything else (server, durable wrapper, LLM clients, Telegram) reads `Config`
 * instead of touching `process.env` or the filesystem directly.
 */
import { join, resolve } from "node:path";
import { loadEnv, type EnvConfig, type LoadEnvOptions } from "./env";
import { loadModelsFile, resolveModelsPath, type ModelsConfig } from "./models";
import type { LogLevel } from "./logger";

export interface ConfigSecrets {
  groqApiKey?: string;
  mistralApiKey?: string;
  telegramBotToken?: string;
}

/** Role fallback keys from ADR 0004 (two static keys, one per role). */
export interface RoleKeys {
  parentKey: string;
  childKey: string;
}

export interface Config {
  port: number;
  /** Absolute data directory (SQLite files, photos). Created by the caller, not here. */
  dataDir: string;
  /** `DATA_DIR/photos` — check-in photos and screenshots. */
  photosDir: string;
  /**
   * Domain SQLite file. The spec says a single file; whether pi-durable shares
   * it or keeps its own is pinned by R1 K2 / S1 — this field is the one place to change.
   */
  dbPath: string;
  logLevel: LogLevel;
  /** M1 echo path (`HMWRK_ECHO=1`): answer without a model instead of running the agent. */
  echo: boolean;
  /**
   * Faux-LLM test hook (`HMWRK_FAUX_LLM=1`): `boot` swaps groq/mistral for pi-ai's scripted faux
   * provider, so the whole cycle runs without API keys. `scriptPath` is `HMWRK_FAUX_SCRIPT`.
   */
  faux: { enabled: boolean; scriptPath?: string };
  models: ModelsConfig;
  /** Resolved models.json path that was actually loaded (log it at boot). */
  modelsPath: string;
  secrets: ConfigSecrets;
  roles: RoleKeys;
  /**
   * Telegram Bot API origin (`TELEGRAM_API_URL`), e.g. a local mock for the e2e run (I3).
   * Unset → `createTelegramClient` falls back to `https://api.telegram.org`.
   */
  telegramApiUrl?: string;
}

export interface LoadConfigOptions extends LoadEnvOptions {
  /** Explicit models.json path; takes precedence over `MODELS_CONFIG`. */
  modelsPath?: string;
}

/** Reads and validates everything needed to boot. Throws `ConfigError` on bad input. */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env: EnvConfig = loadEnv(options);
  const dataDir = resolve(process.cwd(), env.DATA_DIR);
  // An explicit option may be relative to cwd; MODELS_CONFIG must be absolute.
  const modelsPath =
    options.modelsPath !== undefined
      ? resolve(process.cwd(), options.modelsPath)
      : resolveModelsPath({ dataDir, override: env.MODELS_CONFIG });

  return {
    port: env.PORT,
    dataDir,
    photosDir: join(dataDir, "photos"),
    dbPath: join(dataDir, "hmwrk.sqlite"),
    logLevel: env.LOG_LEVEL,
    echo: env.HMWRK_ECHO,
    faux: {
      enabled: env.HMWRK_FAUX_LLM,
      ...(env.HMWRK_FAUX_SCRIPT === undefined ? {} : { scriptPath: resolve(process.cwd(), env.HMWRK_FAUX_SCRIPT) }),
    },
    models: loadModelsFile(modelsPath),
    modelsPath,
    secrets: {
      groqApiKey: env.GROQ_API_KEY,
      mistralApiKey: env.MISTRAL_API_KEY,
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    },
    roles: {
      parentKey: env.HMWRK_PARENT_KEY,
      childKey: env.HMWRK_CHILD_KEY,
    },
    ...(env.TELEGRAM_API_URL === undefined ? {} : { telegramApiUrl: env.TELEGRAM_API_URL }),
  };
}

export * from "./env";
export * from "./errors";
export * from "./logger";
export * from "./models";
