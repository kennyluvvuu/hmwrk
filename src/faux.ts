/**
 * Faux-LLM test hook (I2): pi-ai's scripted provider instead of groq/mistral.
 *
 * Enabled by `HMWRK_FAUX_LLM=1`; the script comes from `HMWRK_FAUX_SCRIPT` (JSON). The point is a
 * **key-less, offline full cycle**: the OpenAI endpoint runs the real agent (tools, prompt),
 * `submit_check_in` starts the real verify task, and both models answer from the script.
 *
 * One provider per slot, so the queues are independent and deterministic:
 *
 * - `faux-chat` — the conversational model of the durable conversation (SPEC §7 `chat`),
 *   answering with text and/or tool calls;
 * - `faux-read` — the vision stage of the verify task (`read`), declared with image input;
 * - `faux-verify` — the grading stage of the verify task (`verify`), answering with the verdict JSON.
 *
 * With a single shared queue the verify task would steal the chat model's next response (tasks run
 * concurrently with the turn that spawned them), which is exactly the flakiness this split removes.
 *
 * ## Script format (`HMWRK_FAUX_SCRIPT`, and the shape P2's `verify-m2.sh` writes)
 *
 * ```json
 * {
 *   "chat":   ["Здравствуйте! Чем помочь?"],
 *   "read":   ["№ 12: 5 + 7 = 12"],
 *   "verify": ["{\"items\":[{\"label\":\"№ 12\",\"verdict\":\"ok\",\"comment\":\"верно\"}],\"summary\":\"…\"}"],
 *   "repeatLast": { "chat": 20 }
 * }
 * ```
 *
 * A step is either a plain string (a text answer, `stopReason: "stop"`) or an object:
 *
 * ```json
 * { "text": "добавил", "toolCalls": [{ "name": "manual_add_assignment", "arguments": { … } }] }
 * ```
 *
 * `stopReason` defaults to `"toolUse"` when the step carries tool calls and `"stop"` otherwise.
 * `repeatLast` appends the last step of a slot that many more times — the chat queue of a scripted
 * e2e run is otherwise exhausted after a handful of messages.
 *
 * Nothing here is production code: the models do not exist outside a faux `Models` collection, and
 * boot only takes this path when the env flag says so. `models.json` still validates against the
 * real provider list, so the faux slots are built here and injected, never read from the file.
 */

import { readFile } from "node:fs/promises";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Models,
} from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Logger, ModelSlot, ModelsConfig } from "./config/index.js";

/** Provider ids of the three faux models; also their model ids (one model per provider). */
export const FAUX_PROVIDERS = {
  read: "faux-read",
  verify: "faux-verify",
  chat: "faux-chat",
} as const satisfies Record<ModelSlot, string>;

/** Slots the boot concern needs: the fake `Models` collection plus the refs that point at it. */
export interface FauxLlmSetup {
  readonly models: Models;
  readonly slots: ModelsConfig;
  /** Per-slot handles, for logs and for tests that queue responses programmatically. */
  readonly handles: Record<ModelSlot, FauxProviderHandle>;
}

// ---------------------------------------------------------------------------
// Script parsing
// ---------------------------------------------------------------------------

const FauxToolCallSchema = z.object({
  name: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const FauxStepSchema = z.union([
  z.string(),
  z.object({
    text: z.string().optional(),
    toolCalls: z.array(FauxToolCallSchema).optional(),
    stopReason: z.enum(["stop", "toolUse", "length", "error"]).optional(),
  }),
]);

/** The JSON file format (see the module comment). Every field is optional. */
export const FauxScriptSchema = z.object({
  chat: z.array(FauxStepSchema).optional(),
  read: z.array(FauxStepSchema).optional(),
  verify: z.array(FauxStepSchema).optional(),
  /**
   * Extra copies of the last step per slot, so a chat queue outlives a handful of messages.
   * `partialRecord`: any subset of the slots may be given (`record` would require all three).
   */
  repeatLast: z
    .partialRecord(z.enum(["chat", "read", "verify"]), z.number().int().min(0).max(1000))
    .optional(),
});

export type FauxScript = z.infer<typeof FauxScriptSchema>;
export type FauxStep = z.infer<typeof FauxStepSchema>;

/** One script step → the provider's queue entry. */
export function toFauxStep(step: FauxStep): FauxResponseStep {
  if (typeof step === "string") return fauxAssistantMessage(step);

  const blocks = [
    ...(step.toolCalls ?? []).map((call) => fauxToolCall(call.name, (call.arguments ?? {}) as JsonObject)),
    ...(step.text === undefined || step.text === "" ? [] : [fauxText(step.text)]),
  ];
  const stopReason = step.stopReason ?? (step.toolCalls === undefined ? "stop" : "toolUse");
  return fauxAssistantMessage(blocks.length === 0 ? "" : blocks, { stopReason });
}

/** Parse + validate a script; throws with the file path on invalid JSON or an invalid shape. */
export function parseFauxScript(raw: unknown, source = "faux script"): FauxScript {
  const result = FauxScriptSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid faux script ${source}: ${problems}`);
}

function queueFor(script: FauxScript, slot: ModelSlot): FauxResponseStep[] {
  const steps = (script[slot] ?? []).map(toFauxStep);
  const repeats = script.repeatLast?.[slot] ?? 0;
  const last = steps.at(-1);
  if (last !== undefined) for (let index = 0; index < repeats; index += 1) steps.push(last);
  return steps;
}

// ---------------------------------------------------------------------------
// Model collection
// ---------------------------------------------------------------------------

/**
 * Build the faux `Models` collection and the slot refs that resolve into it.
 *
 * The refs are cast because `models.json` only accepts the real providers (`MODEL_PROVIDERS` in
 * `src/config/models.ts`); they are injected into boot as an internal seam, never written to the file.
 */
export function buildFauxLlm(script: FauxScript = {}): FauxLlmSetup {
  const models = createModels();
  const handles = {} as Record<ModelSlot, FauxProviderHandle>;

  for (const slot of ["read", "verify", "chat"] as const) {
    const handle = fauxProvider({
      provider: FAUX_PROVIDERS[slot],
      models: [
        slot === "read"
          ? { id: FAUX_PROVIDERS.read, input: ["text", "image"] as ("text" | "image")[] }
          : { id: FAUX_PROVIDERS[slot] },
      ],
    });
    models.setProvider(handle.provider);
    handle.setResponses(queueFor(script, slot));
    handles[slot] = handle;
  }

  const slots = {
    read: { provider: FAUX_PROVIDERS.read, modelId: FAUX_PROVIDERS.read },
    verify: { provider: FAUX_PROVIDERS.verify, modelId: FAUX_PROVIDERS.verify },
    chat: { provider: FAUX_PROVIDERS.chat, modelId: FAUX_PROVIDERS.chat },
  } as unknown as ModelsConfig;

  return { models, slots, handles };
}

export interface LoadFauxScriptOptions {
  /** `HMWRK_FAUX_SCRIPT`; absent → every queue is empty (the provider answers with an error). */
  readonly scriptPath?: string;
  readonly logger?: Logger;
}

/** Read + parse the script file (or return an empty script and say so). */
export async function loadFauxScript(options: LoadFauxScriptOptions = {}): Promise<FauxScript> {
  if (options.scriptPath === undefined) {
    options.logger?.warn("HMWRK_FAUX_LLM is on but HMWRK_FAUX_SCRIPT is unset; every model call will fail", {
      hint: "see src/faux.ts for the script format",
    });
    return {};
  }
  let text: string;
  try {
    text = await readFile(options.scriptPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read HMWRK_FAUX_SCRIPT ${options.scriptPath}: ${errorMessage(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`HMWRK_FAUX_SCRIPT ${options.scriptPath} is not valid JSON: ${errorMessage(error)}`);
  }
  return parseFauxScript(raw, options.scriptPath);
}

/** Env-driven convenience: read the script file and build the collection in one call (boot). */
export async function createFauxLlm(options: LoadFauxScriptOptions = {}): Promise<FauxLlmSetup> {
  const script = await loadFauxScript(options);
  return buildFauxLlm(script);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
