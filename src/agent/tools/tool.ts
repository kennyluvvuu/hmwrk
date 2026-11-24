/**
 * The frame every one of the nine SPEC §5.5 tools is built on.
 *
 * One tool = {@link DomainTool}: a name, RU text for the model, and a `run()` that works only on
 * the domain layer (`Repos` from T1) plus the {@link VerifySpawner} seam. It knows nothing about
 * SQL, Telegram or durable tasks — {@link createToolRegistration} wraps it into pi-durable's
 * `ToolRegistration` (K7), which is where the pi-specific parts live:
 *
 * - **parameters** — `z.toJSONSchema(toolArgsSchemas[name], { io: "input" })`, authored in T1 and
 *   validated by pi-schema with coercion, so a wrong-typed argument already comes back to the
 *   model as a `<harness>[error] …</harness>` result (`docs/research/pi-api-notes.md`, K7);
 * - **role gating** — the role is *not* a tool argument. `execute()` receives `api.conversationId`
 *   (`ToolExecutionApi`), and {@link ActorDirectory.get} maps that id to `{ userId, role }` (K3).
 *   The tool then asks T1's `isToolAllowed`, so the model cannot talk itself into a parent-only
 *   action; an unknown conversation is refused instead of guessing a role;
 * - **argument re-validation** — JSON Schema cannot express every zod refinement (the
 *   `due_at`/`due_date` exclusion, the `photo_ids`-or-`hint` rule), so `parseToolArgs` runs again
 *   in-process and its failure becomes one RU sentence rather than a stack trace;
 * - **errors** — `ToolRefusal` (or a domain error) becomes `isError: true` with RU text: the action
 *   did not happen and the model is told so in words it can relay to a person.
 */

import type {
  ConversationId,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { ActorDirectory, ActorRecord } from "../../contracts/index.js";
import type { VerifySpawner } from "../../contracts/tasks.js";
import { DomainError } from "../../domain/errors.js";
import { parseToolArgs, toolArgsSchema } from "../../domain/schemas.js";
import { isToolAllowed } from "../../domain/types.js";
import type { Repos, SettingKey, ToolArgs, ToolName } from "../../domain/index.js";
import { ROLE_TITLE_RU } from "./format.js";
import type { ScreenshotIntake } from "./screenshot-draft.js";

/** Everything a toolset needs, assembled by {@link import("./index.js").createHmwrkTools}. */
export interface ToolEnvironment {
  readonly repos: Repos;
  readonly spawnVerify: VerifySpawner;
  readonly now: () => Date;
  /** K3: conversation → person. The only source of the role; tool arguments never carry it. */
  readonly actors: ActorDirectory;
  /**
   * Vision reader + photo file store of `parse_screenshot` (P1). Optional on purpose: the toolset
   * also runs in contexts that do not wire V2/D2 (tool tests), and the tool then says the intake
   * half is not connected instead of failing in an unclear way.
   */
  readonly intake?: ScreenshotIntake;
  /**
   * I3: called after a successful `set_setting` of a broadcast schedule key (`reminder_time`,
   * `digest_time`). Boot passes the notify scheduler's `reschedule`; without it (tool tests, a boot
   * with no Telegram token) the change simply applies from the next cycle.
   */
  readonly onScheduleSettingsChanged?: (key: SettingKey) => void | Promise<void>;
}

/** One call, already authorised: who calls, against which data, at which instant. */
export interface ToolRun {
  readonly actor: ActorRecord;
  readonly repos: Repos;
  readonly spawnVerify: VerifySpawner;
  /** Clock read once per call, so one result is internally consistent. */
  readonly now: Date;
  /** See {@link ToolEnvironment.intake}. */
  readonly intake?: ScreenshotIntake;
  /** See {@link ToolEnvironment.onScheduleSettingsChanged}. */
  readonly onScheduleSettingsChanged?: (key: SettingKey) => void | Promise<void>;
}

/**
 * A domain tool, before it is dressed as a pi-durable registration.
 *
 * `title` is the short RU name of the action (`добавить задание`); it appears in refusals, so a
 * child who tried a parent action reads a sentence about a thing, not about a tool id.
 */
export interface DomainTool<N extends ToolName> {
  readonly name: N;
  readonly title: string;
  /** RU description for the model: what it does and when to call it (SPEC §5.5 agents speak RU). */
  readonly description: string;
  /** RU summary of the accepted arguments, repeated when validation fails. */
  readonly argsHint: string;
  /** The work itself. Returns the text the model sees; throws {@link ToolRefusal} to decline. */
  readonly run: (run: ToolRun, args: ToolArgs<N>) => Promise<string>;
}

/** Identity helper: keeps the name → args-schema link checked at the definition site. */
export function defineDomainTool<N extends ToolName>(tool: DomainTool<N>): DomainTool<N> {
  return tool;
}

/**
 * A declined request with a message meant for a person: «не нашёл фото», «задание уже сдано».
 * Raised inside `run()`; {@link createToolRegistration} turns it into an `isError` result as is.
 */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

/** A text result for the model. */
export function textResult(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }] };
}

/** A result that says «ничего не сделано» together with the RU reason. */
export function errorResult(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }], isError: true };
}

/**
 * K7 bridge: zod (authoring, T1) → JSON Schema (what pi-schema validates).
 *
 * `io: "input"` is required because several schemas carry `.transform()` (a time of day is
 * normalised); the model must see the *input* shape it is expected to produce.
 */
export function toolParameters(name: ToolName): Record<string, unknown> {
  return z.toJSONSchema(toolArgsSchema(name), { io: "input" }) as unknown as Record<string, unknown>;
}

/** Wrap one {@link DomainTool} into the `ToolRegistration` A1's extension installs. */
export function createToolRegistration<N extends ToolName>(
  tool: DomainTool<N>,
  env: ToolEnvironment,
): ToolRegistration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toolParameters(tool.name),
    execute: async (args, api) => runDomainTool(tool, env, args, api),
  };
}

/**
 * The full call path: person → permission → arguments → domain work → text.
 *
 * `api` is narrowed to the one field used here (`conversationId`) so tests can pass a stand-in
 * instead of faking a whole `ToolExecutionApi`.
 */
async function runDomainTool<N extends ToolName>(
  tool: DomainTool<N>,
  env: ToolEnvironment,
  rawArgs: unknown,
  api: Pick<ToolExecutionApi, "conversationId">,
): Promise<ToolExecutionResult> {
  const actor = await resolveActor(env.actors, api.conversationId);
  if (actor === null) return errorResult(UNKNOWN_ACTOR_TEXT);

  if (!isToolAllowed(actor.role, tool.name)) return errorResult(roleRefusal(tool, actor.role));

  let args: ToolArgs<N>;
  try {
    args = parseToolArgs(tool.name, rawArgs);
  } catch (error) {
    return errorResult(argumentRefusal(tool, error));
  }

  const run: ToolRun = {
    actor,
    repos: env.repos,
    spawnVerify: env.spawnVerify,
    now: env.now(),
    ...(env.intake === undefined ? {} : { intake: env.intake }),
    ...(env.onScheduleSettingsChanged === undefined
      ? {}
      : { onScheduleSettingsChanged: env.onScheduleSettingsChanged }),
  };
  try {
    return textResult(await tool.run(run, args));
  } catch (error) {
    return errorResult(failureText(tool, error));
  }
}

/**
 * K3 lookup with a least-privilege failure: a throwing directory is «unknown», never «parent».
 * The mapping is written together with the conversation, so this is a should-not-happen path.
 */
async function resolveActor(actors: ActorDirectory, conversationId: ConversationId): Promise<ActorRecord | null> {
  try {
    return await actors.get(conversationId);
  } catch {
    return null;
  }
}

const UNKNOWN_ACTOR_TEXT =
  "Не понял, кто со мной говорит: эта беседа не связана ни с родителем, ни с ребёнком, поэтому ничего не сделано. " +
  "Перезайди в чат; если не поможет — скажи об этом родителю.";

/** `добавить задание` → `«Добавить задание»`: a refusal starts a sentence with the action. */
function quotedTitle<N extends ToolName>(tool: DomainTool<N>): string {
  return `«${tool.title.charAt(0).toUpperCase()}${tool.title.slice(1)}»`;
}

/** Refusal wording per role: SPEC §4 phrases the rule, the tool repeats it in plain RU. */
function roleRefusal<N extends ToolName>(tool: DomainTool<N>, role: ActorRecord["role"]): string {
  if (role === "child") {
    return `${quotedTitle(tool)} — это действие родителя: у ребёнка его нет (SPEC §4). Ничего не изменено. Попроси родителя сделать это в своём чате.`;
  }
  return `${quotedTitle(tool)} делает только ребёнок: родитель за него не отчитывается (SPEC §4). Ничего не изменено — отчёт приходит от самого ребёнка. Ты сейчас ${ROLE_TITLE_RU[role]}.`;
}

/**
 * The domain layer authors a handful of `refine` messages; JSON Schema cannot carry them, and they
 * reach the model through `parseToolArgs`. Translating them here keeps the RU promise of the
 * refusal without touching T1's schemas (they are also read by V2 and D2).
 */
const REFINEMENT_RU: readonly (readonly [RegExp, string])[] = [
  [/Time of day must be HH:MM between 00:00 and 23:59/g, "время должно быть в формате ЧЧ:ММ (00:00–23:59)"],
  [/Provide either due_at or due_date, not both/g, "укажи либо due_at, либо due_date — не оба сразу"],
  [
    /Provide photo_ids of the attached screenshot\(s\) or a textual hint/g,
    "нужен photo_ids скриншотов или текстовый hint",
  ],
];

function translateDetail(detail: string): string {
  return REFINEMENT_RU.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), detail);
}

/** One RU sentence plus the argument hint; the technical detail stays a trailing note. */
function argumentRefusal<N extends ToolName>(tool: DomainTool<N>, error: unknown): string {
  const detail = translateDetail(error instanceof Error ? error.message : String(error));
  return `Не понял аргументы «${tool.title}». ${tool.argsHint} Ничего не изменено.\nТехническое описание: ${detail}`;
}

/** Domain errors are mapped by code: their messages are English (they target developers). */
const DOMAIN_ERROR_TEXT: Record<DomainError["code"], string> = {
  invalid_date: "дата не разобрана — нужен формат ГГГГ-ММ-ДД или ISO-время",
  invalid_time: "время не разобрано — нужен формат ЧЧ:ММ, например 19:00",
  invalid_setting: "значение настройки не подходит",
  invalid_transition: "текущее состояние записи не позволяет это действие — сначала обнови данные",
  invalid_argument: "аргументы не подходят по смыслу",
  not_found: "такой записи нет — возможно, id неверный",
  conflict: "конфликт с уже сохранёнными данными",
};

function failureText<N extends ToolName>(tool: DomainTool<N>, error: unknown): string {
  if (error instanceof ToolRefusal) return error.message;
  if (error instanceof DomainError) {
    // `InvalidValueError` is a `DomainError` too, and its message is developer-facing English.
    return `«${tool.title}»: ${DOMAIN_ERROR_TEXT[error.code]}. Ничего не изменено.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `«${tool.title}»: внутренняя ошибка, ничего не изменено. Попробуй ещё раз; если повторится — скажи родителю. (${detail})`;
}
