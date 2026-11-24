/**
 * Types and schemas of the LLM layer (SPEC §7).
 *
 * Three clients, one per model slot:
 * - `readImages` — the vision model (`read` slot) transcribes notebook photos;
 * - `verifyHomework` — the text model (`verify` slot) solves the items and grades the transcription;
 * - `chat` — the conversational model (`chat` slot) for callers that only need text.
 *
 * Provider ids and model ids never appear here: they come from `models.json` through
 * `src/config/models.ts` (SPEC §7, R1 K8).
 *
 * Structured output: pi-ai 1.6.0 has no schema-constrained completion for chat models (constrained
 * sampling is a *tool* feature, R1 README §Constrained Sampling), so the verify client asks for a
 * strict JSON object, parses it, validates it with {@link VerdictSchema} and retries once. A second
 * failure is honest `unclear`, never a guess (SPEC §5.4).
 */

import { z } from "zod";
import { FINDING_VERDICTS, type FindingVerdict } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Verify output schema
// ---------------------------------------------------------------------------

/**
 * One finding as the `verify` model returns it. `label` is the assignment item label copied from
 * the prompt; the task maps it to `assignment_items.id` (models never see database ids).
 */
export const VerdictItemSchema = z.object({
  label: z.string().trim().min(1).max(200),
  verdict: z.enum(FINDING_VERDICTS),
  comment: z.string().trim().max(2000).optional().default(""),
});

/** The whole verify answer: per-item findings plus a parent-facing summary. */
export const VerdictSchema = z.object({
  items: z.array(VerdictItemSchema).max(200),
  summary: z.string().trim().min(1).max(4000),
});

export type VerdictItem = z.infer<typeof VerdictItemSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;

/** One item of {@link VerifyHomeworkInput}: what the child should have solved. */
export interface VerifyItemInput {
  /** Human label as shown to both roles, e.g. «№ 12». */
  label: string;
  /** Optional note the parent attached to the item. */
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Client inputs and outputs
// ---------------------------------------------------------------------------

/** Image bytes as they come from `data/photos` (no `data:` prefix, no base64 yet). */
export interface ImageAttachment {
  bytes: Uint8Array;
  /** e.g. `image/jpeg`. Only image mime types are forwarded to the model. */
  mime: string;
}

export interface ReadImagesInput {
  /** At least one photo; the task checks emptiness before spending a model call. */
  photos: readonly ImageAttachment[];
  /** Instruction for the vision model (RU is fine — both providers handle it). */
  prompt: string;
}

export interface ReadImagesResult {
  /** Transcription of the photos (solutions item by item). */
  text: string;
  /** `models.json` model id of the `read` slot (for logs, not for the verification row). */
  model: string;
}

export interface VerifyHomeworkInput {
  /** Assignment as text: subject, due date, note — everything the model needs to solve it. */
  assignmentText: string;
  /** Items to grade, in display order. */
  items: readonly VerifyItemInput[];
  /** Transcript of the child's notebook, produced by {@link LlmClients.readImages}. */
  studentSolutionText: string;
}

export interface VerifyHomeworkResult {
  /** One finding per input item, in input order; labels are copied from the input. */
  items: readonly Required<VerdictItem>[];
  /** Parent-facing summary. */
  summary: string;
  /** `models.json` model id of the `verify` slot (stored on the verification row). */
  model: string;
  /**
   * `true` when the model's answer could not be parsed into {@link VerdictSchema} even after one
   * retry: every item is then `unclear` and the summary says so. Callers must not treat such a
   * verdict as an analysis (SPEC §5.4: no guessing).
   */
  degraded: boolean;
}

/** One chat message; the conversational client is a plain text completion. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
}

/** The three clients the project uses; `src/durable/tasks/verify.ts` depends on this interface only. */
export interface LlmClients {
  readImages(input: ReadImagesInput): Promise<ReadImagesResult>;
  verifyHomework(input: VerifyHomeworkInput): Promise<VerifyHomeworkResult>;
  chat(messages: readonly ChatMessage[]): Promise<ChatResult>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why an LLM call failed. Every failure is explicit: no silent fallback to a different model. */
export type LlmErrorCode =
  /** `models.json` names a provider/model pair that pi-ai cannot resolve. */
  | "model_unavailable"
  /** No API key for the provider (pi-ai's auth resolution found nothing). */
  | "missing_auth"
  /** The request did not finish within the configured timeout. */
  | "timeout"
  /** The provider returned an error message or the transport threw. */
  | "request_failed"
  /** The provider answered with no text block. */
  | "empty_response"
  /** Input the client refuses to send (no photos, unknown mime). */
  | "invalid_input";

/** Typed failure of the LLM layer, carrying the slot so logs and task errors name the step. */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly slot?: "read" | "verify" | "chat",
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Verdict used when parsing failed: honest «не разобрал», never a fabricated grade. */
export function unclearItems(items: readonly VerifyItemInput[], reason: string): Required<VerdictItem>[] {
  return items.map((item) => ({
    label: item.label,
    verdict: "unclear" satisfies FindingVerdict,
    comment: reason,
  }));
}
