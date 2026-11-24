/**
 * Per-task model slots (SPEC §7). Concrete model ids live in `models.json`,
 * never in code: switching providers or models is a config edit.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ConfigError, problemsFromZod } from "./errors";

/** M2 will widen this list (see SPEC §7 / R1 K8). */
export const MODEL_PROVIDERS = ["groq", "mistral"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_SLOTS = ["read", "verify", "chat"] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

export const ModelRefSchema = z.strictObject({
  provider: z.enum(MODEL_PROVIDERS, { error: `must be one of: ${MODEL_PROVIDERS.join(", ")}` }),
  modelId: z.string().trim().min(1, "must not be empty"),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const ModelsConfigSchema = z.strictObject({
  /** Free-form note in the file itself (JSON has no comments). Ignored by code. */
  $comment: z.string().optional(),
  read: ModelRefSchema,
  verify: ModelRefSchema,
  chat: ModelRefSchema,
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

/** Validates a parsed models.json value. */
export function parseModels(raw: unknown, source = "models.json"): ModelsConfig {
  const result = ModelsConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError("Invalid models config", problemsFromZod(result.error), source);
  }
  return result.data;
}

/** Parses models.json text, reporting JSON syntax errors against the file path. */
export function parseModelsJson(text: string, source = "models.json"): ModelsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError("Models config is not valid JSON", [{ key: "(file)", reason }], source);
  }
  return parseModels(raw, source);
}

export interface ModelsPathOptions {
  /** Base data directory; models.json is looked up inside it by default. */
  dataDir: string;
  /** `MODELS_CONFIG` value: absolute path override. */
  override?: string | undefined;
}

/** `MODELS_CONFIG` when set (must be absolute), otherwise `<DATA_DIR>/models.json`. */
export function resolveModelsPath(options: ModelsPathOptions): string {
  const override = options.override?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new ConfigError("Invalid MODELS_CONFIG", [
        { key: "MODELS_CONFIG", reason: `must be an absolute path, got "${override}"` },
      ]);
    }
    return override;
  }
  return join(resolve(options.dataDir), "models.json");
}

export type LoadModelsOptions = ModelsPathOptions;

/** Reads and validates an already resolved models.json path. Missing or broken files fail loudly at boot. */
export function loadModelsFile(path: string): ModelsConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "file not found; copy models.example.json to this path and put the real model ids in it"
        : `cannot read file: ${error instanceof Error ? error.message : String(error)}`;
    throw new ConfigError(`Cannot load models config from ${path}: ${reason}`);
  }
  return parseModelsJson(text, path);
}

/** Convenience: resolve the default/overridden path, then load it. */
export function loadModels(options: LoadModelsOptions): ModelsConfig {
  return loadModelsFile(resolveModelsPath(options));
}
