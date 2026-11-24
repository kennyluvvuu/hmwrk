/**
 * Screenshot intake: the draft contract of `parse_screenshot` (SPEC §5.3, P1).
 *
 * The flow is «screenshot → vision (`read` slot, Groq) → structured draft → the parent confirms →
 * assignments are created by `manual_add_assignment`». This module owns the middle part:
 *
 * - {@link ScreenshotDraftSchema} — the zod shape the vision model's JSON must match;
 * - {@link parseScreenshotDraft} — JSON extraction + zod validation, exactly like V2's
 *   `parseVerdict` (models answer with prose around the object, and a wrong answer gets one
 *   corrective retry before the tool degrades honestly);
 * - {@link renderScreenshotDraft} — the RU list a human reads («Математика, срок: не видно —
 *   уточни; пункты: №12, №13»), plus the confirmation rule for the model;
 * - {@link ScreenshotIntake} — the two seams the tool needs beyond the repositories: the V2 read
 *   client and D2's photo file store.
 *
 * Two deliberate non-features (SPEC §5.3 calls the screenshot flow «отладочный канал»): there is
 * no draft table — the draft lives in this one tool result — and a draft never becomes an
 * assignment on its own. Confirmation *is* creation, through `manual_add_assignment`, so the
 * source stays `manual` and the flow keeps working when the journal parser replaces it.
 *
 * Dates (SPEC §11 risk #5): the model returns `due` as `YYYY-MM-DD` only when the date is actually
 * readable on the picture. Everything else is `null` + a warning, and the tool tells the model to
 * ask the parent instead of guessing. A date in some other shape is passed through as text with a
 * warning so one sloppy field cannot throw away a whole draft.
 */

import { z } from "zod";
import { isIsoDate } from "../../domain/dates.js";
import type { Photo } from "../../domain/types.js";
import { extractJsonObject, type LlmClients } from "../../llm/index.js";
import { formatDay, itemCount, photoCount } from "./format.js";

// ---------------------------------------------------------------------------
// Draft schema
// ---------------------------------------------------------------------------

/** One assignment item as the vision model returns it: `label` is copied from the picture. */
export const ScreenshotItemDraftSchema = z.strictObject({
  /** «№12», «стр. 54», «упр. 3». */
  label: z.string().trim().min(1).max(200),
  /** Optional detail that is visible on the screenshot (exercise, page, format). */
  note: z.string().trim().max(2000).optional(),
});

/** One assignment of the draft. `due` is a calendar day when readable, `null` otherwise. */
export const ScreenshotAssignmentDraftSchema = z.strictObject({
  subject: z.string().trim().min(1).max(200),
  /**
   * `YYYY-MM-DD` as read from the screenshot, `null` when the date is absent/unreadable.
   * Any other string is accepted by the schema (the model may answer «25.11») and rendered with a
   * warning: a partially usable draft beats a lost one in a debug-grade channel. A missing key is
   * read as `null` — the model forgetting the field is the same answer as «дату не видно».
   */
  due: z.string().trim().min(1).max(40).nullable().default(null),
  /**
   * Allowed to be empty: the model may read a subject but no items, and the renderer then asks the
   * parent to name them instead of dropping the assignment silently.
   */
  items: z.array(ScreenshotItemDraftSchema).max(100).default([]),
});

/** What `parse_screenshot` produces: the draft plus everything the model was unsure about. */
export const ScreenshotDraftSchema = z.strictObject({
  assignments: z.array(ScreenshotAssignmentDraftSchema).max(50),
  /** Anything uncertain: unreadable date, cropped text, an unclear subject. */
  warnings: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
});

export type ScreenshotItemDraft = z.infer<typeof ScreenshotItemDraftSchema>;
export type ScreenshotAssignmentDraft = z.infer<typeof ScreenshotAssignmentDraftSchema>;
export type ScreenshotDraft = z.infer<typeof ScreenshotDraftSchema>;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * What `parse_screenshot` needs on top of the repositories.
 *
 * Both halves are ports, not implementations: the tool imports neither pi-ai nor `node:fs`, so it
 * stays testable with a scripted reader, and boot (`src/app.ts`) passes the production pair —
 * V2's `readImages` and D2's `PhotoFiles`.
 */
export interface ScreenshotIntake {
  /** Vision client of the `read` slot (Groq in production, a faux provider in tests). */
  readonly readImages: LlmClients["readImages"];
  /** Bytes of a stored screenshot (`PhotoFiles.read`). */
  readonly photoFiles: {
    read(photo: Photo): Promise<Uint8Array>;
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** The JSON shape, shown verbatim in both prompts so nothing has to be inferred. */
export const SCREENSHOT_DRAFT_SHAPE =
  '{"assignments":[{"subject":"Математика","due":"2026-11-25" | null,' +
  '"items":[{"label":"№12","note":"стр. 54"}]}],"warnings":["..."]}';

/**
 * The extraction instruction. RU, like the verify prompts: both providers follow it, and the
 * household vocabulary («пункт», «срок») is the one the parent will read back.
 */
export function intakePrompt(input: { hint?: string }): string {
  return [
    "Ты разбираешь скриншот школьного дневника или списка домашних заданий в структуру.",
    "Верни ТОЛЬКО один JSON-объект, без пояснений, без markdown и без текста вокруг.",
    "",
    "Форма ответа:",
    SCREENSHOT_DRAFT_SHAPE,
    "",
    "Правила:",
    "- один элемент assignments — один предмет; subject — так, как написано на скриншоте;",
    "- due — срок сдачи в формате ГГГГ-ММ-ДД, если дата видна на скриншоте; null, если даты не видно,",
    "  она обрезана или ты не уверен в ней;",
    "- items — пункты задания: label («№12», «стр. 54») и необязательный note (страница, упражнение) —",
    "  только то, что видно на картинке;",
    "- warnings — всё неуверенное: нечитаемая дата, обрезанный текст, непонятный предмет, отсутствие пунктов;",
    "- ничего не придумывай: чего нет на скриншоте, того нет в JSON.",
    ...(input.hint === undefined ? [] : ["", "Подсказка родителя к этому скриншоту:", input.hint]),
  ].join("\n");
}

/** The one corrective turn after an unparsable answer (V2's retry, same wording discipline). */
export function intakeCorrectionPrompt(problems: string): string {
  return [
    `Предыдущий ответ не удалось разобрать: ${problems}.`,
    "Верни ТОЛЬКО один JSON-объект ровно такой формы, без текста вокруг:",
    SCREENSHOT_DRAFT_SHAPE,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ParseScreenshotDraftResult =
  | { ok: true; draft: ScreenshotDraft }
  | { ok: false; problems: string };

/** JSON.parse + zod validation of one vision answer; exported for unit tests. */
export function parseScreenshotDraft(raw: string): ParseScreenshotDraftResult {
  const json = extractJsonObject(raw);
  if (json === null) return { ok: false, problems: "в ответе нет JSON-объекта" };

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, problems: `невалидный JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const parsed = ScreenshotDraftSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, problems };
  }
  return { ok: true, draft: parsed.data };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderScreenshotDraftOptions {
  /** How many photos the draft was read from (the result tells the parent what was looked at). */
  readonly photos: number;
}

/** Model-facing close of every successful result: confirm first, then create. */
export const SCREENSHOT_CONFIRMATION_INSTRUCTIONS = [
  "Покажи этот список родителю как есть и дождись подтверждения: сам задания не создавай — отмена значит, что ничего не создаётся (SPEC §5.3).",
  "После подтверждения создай по одному заданию на предмет через manual_add_assignment: subject, items (строки или {label, note})",
  "и due_date в формате ГГГГ-ММ-ДД.",
  "Если срок «не видно» — сначала спроси дату (SPEC §11, риск №5): без ответа manual_add_assignment возьмёт default_due («завтра 20:00»).",
].join(" ");

/**
 * The human-readable draft the agent relays: one line per subject, warnings after it, and the
 * confirmation rule at the end. Never creates anything — the tool's only output is this text.
 */
export function renderScreenshotDraft(draft: ScreenshotDraft, options: RenderScreenshotDraftOptions): string {
  const warnings = [...draft.warnings, ...derivedWarnings(draft)];
  const lines = [
    `Разобрал ${photoCount(options.photos)} в черновик заданий. Ничего не создано — нужно подтверждение родителя.`,
    "",
  ];

  if (draft.assignments.length === 0) {
    lines.push("Заданий на скриншоте не увидел: заносить нечего.");
  } else {
    draft.assignments.forEach((assignment, index) => lines.push(`${index + 1}. ${renderAssignment(assignment)}`));
  }

  if (warnings.length > 0) {
    lines.push("", "Что не уверен:");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }

  lines.push("", SCREENSHOT_CONFIRMATION_INSTRUCTIONS);
  return lines.join("\n");
}

/** One subject as a person reads it: «Математика», срок: 25.11.2026 — пункты (2 пункта): №12, №13. */
function renderAssignment(assignment: ScreenshotAssignmentDraft): string {
  const items =
    assignment.items.length === 0
      ? "пункты не читаются — попроси родителя назвать их"
      : `пункты (${itemCount(assignment.items.length)}): ${assignment.items.map(renderItem).join(", ")}`;
  return `«${assignment.subject}», срок: ${renderDue(assignment.due)} — ${items}`;
}

function renderItem(item: ScreenshotItemDraft): string {
  return item.note === undefined || item.note === "" ? item.label : `${item.label} (${item.note})`;
}

/**
 * `due` rendering. A calendar day is formatted like the rest of the tools (`25.11.2026`); `null`
 * is the SPEC §11 risk #5 case and says so in words the model can repeat to the parent.
 */
function renderDue(due: string | null): string {
  if (due === null) return "не видно — уточни у родителя (по умолчанию будет «завтра 20:00»)";
  if (isIsoDate(due)) return formatDay(due);
  return `не разобрал точно («${due}») — уточни ГГГГ-ММ-ДД`;
}

/** Warnings the tool adds itself: an empty item list or a date in an unexpected shape. */
function derivedWarnings(draft: ScreenshotDraft): string[] {
  const warnings: string[] = [];
  for (const assignment of draft.assignments) {
    if (assignment.items.length === 0) {
      warnings.push(`по «${assignment.subject}» не видно ни одного пункта — их придётся назвать словами`);
    }
    if (assignment.due !== null && !isIsoDate(assignment.due)) {
      warnings.push(`срок по «${assignment.subject}» распознан неточно: «${assignment.due}»`);
    }
  }
  return warnings;
}

/**
 * The honest dead end (SPEC §5.4 discipline applied to intake): the model twice returned something
 * that is not a draft, so there is no draft and nothing is created. The parent gets a way forward.
 */
export function degradedScreenshotText(problems: string): string {
  return [
    "Не разобрал скриншот в структуру заданий: модель не вернула разбираемый ответ, поэтому ничего не создано и ничего не выдумано.",
    `Причина: ${problems}.`,
    "Что делать: пришли более чёткий скриншот или надиктуй задание словами — тогда заведу его через manual_add_assignment.",
  ].join("\n");
}
