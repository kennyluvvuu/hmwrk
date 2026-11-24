/**
 * LLM clients over pi-ai `Models` (SPEC §7, R1 K8/K10).
 *
 * The same `Models` object the Harness holds is passed in: `Models` owns provider auth and the
 * model catalogue, so this module never reads `process.env` and never hardcodes a model id.
 * Every call is bounded by a timeout; every failure is an {@link LlmError} with a clear code,
 * because the verify task turns it into a durable `failed` outcome instead of a silent retry.
 *
 * Structured output (SPEC §5.4): pi-ai 1.6.0 supports provider-side constrained sampling only for
 * *tools*, not for plain completions (R1 README §Constrained Sampling). So the verify client asks
 * for a strict JSON object, extracts it, validates it with {@link VerdictSchema}, and asks once
 * more when parsing fails. A second failure yields `unclear` for every item — never a guess.
 */

import type {
  AssistantMessage,
  ImageContent,
  Message,
  Models,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import { createLogger, type Logger, type ModelSlot, type ModelsConfig } from "../config/index.js";
import type { FindingVerdict } from "../domain/types.js";
import {
  LlmError,
  VerdictSchema,
  unclearItems,
  type ChatMessage,
  type ChatResult,
  type ImageAttachment,
  type LlmClients,
  type ReadImagesInput,
  type ReadImagesResult,
  type Verdict,
  type VerdictItem,
  type VerifyHomeworkInput,
  type VerifyHomeworkResult,
  type VerifyItemInput,
} from "./types.js";

/** Default per-call timeout. A vision request with a 2–5 MB photo and a long solution can take a while. */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** Zero usage for reconstructed assistant messages in `chat()` history (pi-ai requires the field). */
const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface CreateLlmClientsOptions {
  /** The Harness `Models` collection: providers, auth and catalogue in one object (K8). */
  models: Models;
  /** Per-slot model refs from `models.json` (SPEC §7). */
  slots: Pick<ModelsConfig, "read" | "verify" | "chat">;
  logger?: Logger;
  /** Per-call timeout; default {@link DEFAULT_LLM_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Clock for reconstructed history messages; tests may freeze it. */
  now?: () => number;
}

/**
 * Create the three SPEC §7 clients. Nothing is called at construction: a missing API key surfaces
 * on the first call as `missing_auth`, which is what the durable task records.
 */
export function createLlmClients(options: CreateLlmClientsOptions): LlmClients {
  const { models, slots } = options;
  const logger = options.logger ?? createLogger({ bindings: { module: "llm" } });
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  function modelFor(slot: ModelSlot) {
    const ref = slots[slot];
    const model = models.getModel(ref.provider, ref.modelId);
    if (model === undefined) {
      throw new LlmError(
        "model_unavailable",
        `slot "${slot}" names ${ref.provider}/${ref.modelId}, which is not in the pi-ai catalogue`,
        slot,
      );
    }
    return model;
  }

  /**
   * One bounded completion. `completeSimple` resolves provider-specific options and auth, and
   * reports provider errors as `stopReason: "error"` rather than throwing (pi-ai README §Errors),
   * so both shapes are mapped here.
   */
  async function complete(slot: ModelSlot, messages: Message[]): Promise<AssistantMessage> {
    const model = modelFor(slot);
    const ref = slots[slot];

    let auth: Awaited<ReturnType<Models["getAuth"]>>;
    try {
      auth = await models.getAuth(model);
    } catch (error) {
      throw new LlmError(
        "missing_auth",
        `cannot resolve credentials for ${ref.provider}/${ref.modelId}: ${errorMessage(error)}`,
        slot,
      );
    }
    if (auth === undefined) {
      throw new LlmError(
        "missing_auth",
        `no credentials for provider "${ref.provider}" (model ${ref.modelId}); set the provider's API key`,
        slot,
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await models.completeSimple(model, { messages }, { signal: controller.signal });
      if (timedOut) {
        throw new LlmError("timeout", `${slot} model did not answer within ${timeoutMs} ms`, slot);
      }
      if (response.stopReason === "error") {
        throw new LlmError(
          "request_failed",
          `${slot} model failed: ${response.errorMessage ?? "unknown provider error"}`,
          slot,
        );
      }
      if (response.stopReason === "aborted") {
        throw new LlmError("request_failed", `${slot} model request was aborted`, slot);
      }
      return response;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (timedOut) {
        throw new LlmError("timeout", `${slot} model did not answer within ${timeoutMs} ms`, slot);
      }
      if (isAbortError(error)) {
        throw new LlmError("request_failed", `${slot} model request was aborted`, slot);
      }
      throw new LlmError("request_failed", `${slot} model request failed: ${errorMessage(error)}`, slot);
    } finally {
      clearTimeout(timer);
    }
  }

  function textOf(message: AssistantMessage, slot: ModelSlot): string {
    const text = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text === "") {
      throw new LlmError("empty_response", `${slot} model returned no text`, slot);
    }
    return text;
  }

  // -------------------------------------------------------------------------
  // read: photos → transcript
  // -------------------------------------------------------------------------

  async function readImages(input: ReadImagesInput): Promise<ReadImagesResult> {
    if (input.photos.length === 0) {
      throw new LlmError("invalid_input", "readImages needs at least one photo", "read");
    }
    for (const photo of input.photos) {
      if (!photo.mime.startsWith("image/")) {
        throw new LlmError("invalid_input", `unsupported photo mime "${photo.mime}"`, "read");
      }
      if (photo.bytes.byteLength === 0) {
        throw new LlmError("invalid_input", "photo has no bytes", "read");
      }
    }

    const ref = slots.read;
    const content: (TextContent | ImageContent)[] = [
      { type: "text", text: input.prompt },
      ...input.photos.map((photo): ImageContent => ({
        type: "image",
        data: toBase64(photo),
        mimeType: photo.mime,
      })),
    ];

    const message = await complete("read", [{ role: "user", content, timestamp: now() }]);
    const text = textOf(message, "read");
    logger.debug("read model answered", { model: ref.modelId, photos: input.photos.length, chars: text.length });
    return { text, model: ref.modelId };
  }

  // -------------------------------------------------------------------------
  // verify: two-stage grading → structured verdict
  // -------------------------------------------------------------------------

  async function verifyHomework(input: VerifyHomeworkInput): Promise<VerifyHomeworkResult> {
    const ref = slots.verify;
    const prompt = verifyPrompt(input);
    const messages: Message[] = [{ role: "user", content: prompt, timestamp: now() }];

    const first = await complete("verify", messages);
    const firstText = textOf(first, "verify");
    let parsed = parseVerdict(firstText);

    if (!parsed.ok) {
      // SPEC §5.4: one corrective retry with the parse error, still asking for strict JSON.
      logger.warn("verify model answered with invalid JSON; retrying once", {
        model: ref.modelId,
        problems: parsed.problems,
      });
      messages.push(
        {
          role: "assistant",
          content: [{ type: "text", text: firstText }],
          api: first.api,
          provider: first.provider,
          model: first.model,
          usage: first.usage,
          stopReason: first.stopReason,
          timestamp: first.timestamp,
        },
        {
          role: "user",
          content:
            "Your previous answer could not be parsed. Problems:\n" +
            `${parsed.problems}\n\n` +
            "Return ONLY one JSON object matching the schema. No prose, no markdown fences.",
          timestamp: now(),
        },
      );
      const second = await complete("verify", messages);
      const secondText = textOf(second, "verify");
      parsed = parseVerdict(secondText);
      if (!parsed.ok) {
        logger.error("verify model failed to produce valid JSON twice; marking every item unclear", {
          model: ref.modelId,
          problems: parsed.problems,
        });
        return {
          items: unclearItems(
            input.items,
            "Модель не вернула разбор в нужном формате; проверка невозможна без угадывания.",
          ),
          summary:
            "Автоматическая проверка не удалась: модель дважды вернула ответ, который не удалось разобрать. " +
            "Проверьте тетрадь вручную.",
          model: ref.modelId,
          degraded: true,
        };
      }
    }

    const knownLabels = new Set(input.items.map((item) => normalizeLabel(item.label)));
    const extra = parsed.verdict.items.filter((finding) => !knownLabels.has(normalizeLabel(finding.label))).length;
    if (extra > 0) {
      logger.warn("verify model returned findings for unknown labels; ignoring them", {
        model: ref.modelId,
        extra,
      });
    }

    const items = alignFindings(input.items, parsed.verdict.items);
    logger.info("verify model produced a verdict", {
      model: ref.modelId,
      items: items.length,
      verdicts: countVerdicts(items),
    });
    return {
      items,
      summary: parsed.verdict.summary,
      model: ref.modelId,
      degraded: false,
    };
  }

  // -------------------------------------------------------------------------
  // chat: plain text completion
  // -------------------------------------------------------------------------

  async function chat(messages: readonly ChatMessage[]): Promise<ChatResult> {
    if (messages.length === 0) {
      throw new LlmError("invalid_input", "chat needs at least one message", "chat");
    }
    const ref = slots.chat;
    const context: Message[] = messages.map((message): Message => {
      if (message.role === "system") {
        return { role: "system", content: message.content, timestamp: now() };
      }
      if (message.role === "assistant") {
        return {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          api: "openai-completions",
          provider: ref.provider,
          model: ref.modelId,
          usage: EMPTY_USAGE,
          stopReason: "stop",
          timestamp: now(),
        };
      }
      return { role: "user", content: message.content, timestamp: now() };
    });
    const message = await complete("chat", context);
    return { text: textOf(message, "chat"), model: ref.modelId };
  }

  return { readImages, verifyHomework, chat };
}

// ---------------------------------------------------------------------------
// Verify prompt and parsing
// ---------------------------------------------------------------------------

/** The model returns this shape; the prompt shows it verbatim so nothing has to be inferred. */
const VERDICT_SHAPE =
  '{"items":[{"label":"<exact item label>","verdict":"ok|wrong|missing|unclear","comment":"<short explanation>"}],"summary":"<1-3 sentences for the parent>"}';

export function verifyPrompt(input: VerifyHomeworkInput): string {
  const items = input.items.map((item) => ({
    label: item.label,
    note: item.note ?? null,
  }));
  return [
    "You are the second stage of homework verification: you solve the assignment yourself and compare",
    "your solution with a transcription of the child's notebook. Return ONLY one JSON object, no prose.",
    "",
    "JSON schema:",
    VERDICT_SHAPE,
    "",
    "Rules:",
    "- Grade every item below and copy its label exactly as written.",
    '- "ok" — the child solved it correctly; "wrong" — attempted but incorrect;',
    '- "missing" — not attempted at all; "unclear" — the transcription does not let you decide.',
    "- Never guess: when the transcription is illegible, incomplete or you are unsure, use \"unclear\"",
    "  and say what is missing in the comment.",
    "- The comment is short (one sentence). The summary is for the parent: how many items are fine,",
    "  what needs attention.",
    "",
    "Assignment:",
    input.assignmentText,
    "",
    "Items to grade (JSON):",
    JSON.stringify(items),
    "",
    "Transcription of the child's solutions:",
    input.studentSolutionText,
  ].join("\n");
}

export type ParseVerdictResult =
  | { ok: true; verdict: Verdict }
  | { ok: false; problems: string };

/** JSON.parse + zod validation of one model answer; exported for unit tests. */
export function parseVerdict(raw: string): ParseVerdictResult {
  const json = extractJsonObject(raw);
  if (json === null) {
    return { ok: false, problems: "the answer contains no JSON object" };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, problems: `invalid JSON: ${errorMessage(error)}` };
  }
  const parsed = VerdictSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, problems };
  }
  return { ok: true, verdict: parsed.data };
}

/**
 * The first `{` to the last `}` — tolerant of prose and markdown fences around the object.
 * Deliberately not a brace-balancing parser: models answer with one object, and a wrong slice
 * fails `JSON.parse` and triggers the retry.
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/**
 * Map model findings (by label) onto the assignment items, preserving item order.
 *
 * An item the model skipped gets `unclear` with a comment — this is the honest signal, not a
 * guessed `ok`. Findings for labels that are not in the assignment are ignored (logged count).
 */
export function alignFindings(
  items: readonly VerifyItemInput[],
  findings: readonly { label: string; verdict: FindingVerdict; comment: string }[],
): Required<VerdictItem>[] {
  const byLabel = new Map<string, { verdict: FindingVerdict; comment: string }>();
  for (const finding of findings) {
    const key = normalizeLabel(finding.label);
    if (!byLabel.has(key)) byLabel.set(key, { verdict: finding.verdict, comment: finding.comment });
  }
  return items.map((item) => {
    const found = byLabel.get(normalizeLabel(item.label));
    if (found === undefined) {
      return {
        label: item.label,
        verdict: "unclear",
        comment: "Модель не дала отдельного вердикта по этому пункту.",
      };
    }
    return { label: item.label, verdict: found.verdict, comment: found.comment };
  });
}

/** Labels are compared loosely: case, surrounding whitespace and the «№» prefix are noise. */
function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^№\s*/, "")
    .replace(/\s+/g, " ");
}

function countVerdicts(items: readonly { verdict: FindingVerdict }[]): Record<FindingVerdict, number> {
  const counts: Record<FindingVerdict, number> = { ok: 0, wrong: 0, missing: 0, unclear: 0 };
  for (const item of items) counts[item.verdict] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Buffer-backed base64 without the `data:` prefix (K10: `ImageContent.data`). */
function toBase64(photo: ImageAttachment): string {
  return Buffer.from(photo.bytes).toString("base64");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
