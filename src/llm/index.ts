/**
 * LLM layer barrel (V2).
 *
 * - {@link createLlmClients} — read/verify/chat clients over the Harness `Models` object;
 * - {@link VerdictSchema} — the structured output contract of the verify step (zod);
 * - {@link LlmError} — typed, non-magical failures (the verify task maps them to `failed`).
 *
 * Provider and model ids come exclusively from `models.json` (SPEC §7); no keys or ids live here.
 */

export * from "./types.js";
export * from "./llm.js";
