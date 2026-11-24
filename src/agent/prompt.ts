/**
 * System prompt of the `hmwrk` agent (SPEC §6), in Russian.
 *
 * The prompt is one text rendered per request; it answers four things SPEC §6 asks a system
 * prompt to answer:
 *
 * 1. **role** — who is talking (parent / child) and what that role may and may not do (SPEC §4);
 * 2. **active assignments** — a short summary, when the caller has one (M2 feeds it);
 * 3. **tools** — the exact list of what is callable, or, in M1, the honest "not connected yet";
 * 4. **date format** — `DD.MM.YYYY`, with today's date passed in as a parameter.
 *
 * M1 status (the whole module is the M1 skeleton): the agent has **no** domain tools. The prompt
 * says so in words the model cannot misread, because a model that pretends to have added an
 * assignment is worse than one that says "эта возможность ещё не подключена" (see A1's brief:
 * «честность важнее имитации»).
 *
 * Pure module: no I/O, no clock of its own — role and date arrive from `src/agent/extension.ts`.
 */

import type { AgentCapabilities, AgentPromptContext, ToolName } from "../contracts/index.js";
import { isIsoDate, parseIsoDate } from "../domain/dates.js";
import type { AssignmentStatus, IsoDate, IsoDateTime, Role } from "../domain/types.js";

/** Uppercase display name of a role (SPEC §4: «Родитель» / «Ребёнок»). */
const ROLE_TITLE: Record<Role, string> = {
  parent: "Родитель",
  child: "Ребёнок",
};

/**
 * What the role may do, in the prompt's own words (SPEC §4). Deliberately short: M2's tools
 * enforce the rules anyway (A2), the prompt only stops the model from offering the wrong action.
 */
const ROLE_RULES: Record<Role, readonly string[]> = {
  parent: [
    "Ты видишь все вердикты, включая черновики: черновик ещё не показан ребёнку и ждёт твоего решения.",
    "Ты утверждаешь или отклоняешь вердикты — только после этого ребёнок узнаёт результат.",
    "Ты заводишь задания (вручную или по скриншоту дневника) и настраиваешь времена напоминаний и паузу.",
    "Ты не отчитываешься за ребёнка: отчёт о выполнении приходит от него самого.",
  ],
  child: [
    "Ты помогаешь ребёнку отчитаться о выполненном задании и приложить фото тетради.",
    "Ты показываешь только утверждённые вердикты. Черновик вердикта — это ещё не результат проверки, о нём не сообщай.",
    "Ты не заводишь и не меняешь задания, не утверждаешь вердикты и не меняешь настройки: это делает родитель. На такую просьбу отвечай вежливо и не обещай сделать её сам.",
  ],
};

/** Russian weekday names, `Date#getDay()` order. Static, so rendering needs no ICU locale data. */
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"] as const;

/** Status as the prompt words it for a human (SPEC §5.1). */
const STATUS_TITLE: Record<AssignmentStatus, string> = {
  active: "ждёт отчёта",
  in_review: "на проверке",
  done: "сдано",
};

/**
 * One line of the active-assignments summary. Reuses the domain `Assignment` fields on purpose:
 * M2 passes rows it already loaded, nothing new to keep in sync.
 */
export type AgentAssignmentSummary = {
  readonly subject: string;
  readonly due_at: IsoDateTime;
  readonly status: AssignmentStatus;
};

/** More lines than this make the prompt long without making it more useful. */
export const MAX_ASSIGNMENT_LINES = 8;

/**
 * One-line RU purpose of each SPEC §5.5 tool. Prompt text only: the tool itself carries the
 * authoritative description (A2/K7), this list exists so the model knows **which** of its tools
 * is the right one before it reads schemas.
 */
const TOOL_PURPOSE: Record<ToolName, string> = {
  list_assignments: "активные задания с дедлайнами и статусами",
  parse_screenshot: "разобрать фото дневника или задания в черновик заданий (родитель подтверждает)",
  manual_add_assignment: "добавить задание вручную",
  submit_check_in: "отчёт ребёнка о выполненном задании, можно с фото тетради",
  get_verdicts: "вердикты проверки (родитель видит и черновики, ребёнок — только утверждённые)",
  approve_verification: "утвердить черновик вердикта",
  dismiss_verification: "отклонить черновик вердикта",
  get_settings: "текущие настройки: времена напоминаний и пауза",
  set_setting: "изменить настройку",
};

/**
 * Format a calendar day as the prompt's human date, `DD.MM.YYYY` (SPEC §6).
 *
 * Never throws: an unparsable value is returned as is, because a broken date must not cost the
 * model its whole system prompt (a throwing section is reported as `extension_error` and omitted).
 */
export function formatPromptDate(day: IsoDate): string {
  if (!isIsoDate(day)) return day;
  const [year = "", month = "", date = ""] = day.split("-");
  return `${date}.${month}.${year}`;
}

/** `DD.MM.YYYY` of an instant, in the process local timezone (household timezone). */
export function formatPromptInstant(instant: IsoDateTime): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${String(date.getFullYear()).padStart(4, "0")}`;
}

/** Russian weekday of a calendar day, or an empty string for garbage input. */
export function weekdayTitle(day: IsoDate): string {
  if (!isIsoDate(day)) return "";
  return WEEKDAYS[parseIsoDate(day).getDay()] ?? "";
}

/**
 * The whole system prompt for one request (SPEC §6). This is `AgentPromptRenderer` from
 * `src/contracts/agent.ts`, with the M2 assignment summary as an optional third parameter.
 */
export function renderAgentPrompt(
  ctx: AgentPromptContext,
  capabilities: AgentCapabilities = { kind: "skeleton" },
  assignments: readonly AgentAssignmentSummary[] = [],
): string {
  return [
    intro(),
    roleBlock(ctx.role),
    dateBlock(ctx.today),
    behaviourBlock(),
    assignmentsBlock(assignments, capabilities, ctx.now),
    toolsBlock(capabilities),
  ]
    .join("\n\n")
    .concat("\n");
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function intro(): string {
  return (
    "Ты — hmwrk, ассистент по домашним заданиям. Ты помогаешь семье вести школьные задания: " +
    "что задано, что сдано, что проверено и когда об этом напомнить."
  );
}

function roleBlock(role: Role): string {
  const rules = ROLE_RULES[role].map((rule) => `- ${rule}`).join("\n");
  return `# Кто с тобой разговаривает\n\nСейчас это ${ROLE_TITLE[role]}.\n\n${rules}`;
}

function dateBlock(today: IsoDate): string {
  const weekday = weekdayTitle(today);
  const human = formatPromptDate(today);
  const todayLine = weekday === "" ? human : `${human}, ${weekday}`;
  return [
    "# Дата",
    `Сегодня: ${todayLine}.`,
    "Все даты в ответах пиши в формате DD.MM.YYYY (например, 05.12.2026), время — HH:MM.",
    "Сегодняшняя дата — та, что указана выше; не вычисляй и не выдумывай её.",
  ].join("\n");
}

function behaviourBlock(): string {
  return [
    "# Как отвечать",
    "- По-русски, коротко и по делу.",
    "- Не выдумывай задания, вердикты, статусы и времена: если факта нет в разговоре или в инструментах, скажи, что его нет.",
    "- Если просьба непонятна, задай один уточняющий вопрос, а не три.",
  ].join("\n");
}

function assignmentsBlock(
  assignments: readonly AgentAssignmentSummary[],
  capabilities: AgentCapabilities,
  now: Date,
): string {
  const header = "# Активные задания";
  if (assignments.length === 0) {
    const empty =
      capabilities.kind === "skeleton"
        ? "Сводки активных заданий пока нет: она появится вместе с инструментами."
        : "Активных заданий нет.";
    return `${header}\n\n${empty}`;
  }

  const shown = assignments.slice(0, MAX_ASSIGNMENT_LINES);
  const lines = shown.map((item) => {
    const status = STATUS_TITLE[item.status] ?? item.status;
    const overdue = isOverdueSummary(item, now) ? ", просрочено" : "";
    return `- ${formatPromptInstant(item.due_at)} — ${item.subject} — ${status}${overdue}`;
  });
  const rest = assignments.length - shown.length;
  if (rest > 0) lines.push(`- …и ещё ${rest}`);

  return `${header}\n\n${lines.join("\n")}`;
}

/**
 * Overdue is derived, never stored (SPEC §5.1): active and the due instant has passed. Takes
 * `ctx.now` rather than the wall clock, so one request renders one consistent prompt.
 */
function isOverdueSummary(item: AgentAssignmentSummary, now: Date): boolean {
  if (item.status !== "active") return false;
  const due = new Date(item.due_at).getTime();
  return !Number.isNaN(due) && due < now.getTime();
}

function toolsBlock(capabilities: AgentCapabilities): string {
  const header = "# Инструменты";
  if (capabilities.kind === "skeleton") {
    return [
      header,
      "Доменных инструментов у тебя пока нет: они подключаются в следующей вехе. Поэтому:",
      "- не изображай вызов инструмента и не придумывай его результат;",
      "- не выдавай свой текст за список заданий, вердикт или настройки;",
      "- если просят добавить задание, показать список, дать или утвердить вердикт, поменять напоминание — " +
        "честно скажи, что эта возможность ещё не подключена, и не предлагай несуществующих кнопок. " +
        "Честность важнее имитации.",
    ].join("\n");
  }

  const lines = capabilities.tools.map((tool) => `- \`${tool}\` — ${TOOL_PURPOSE[tool] ?? "инструмент hmwrk"}`);
  return [
    header,
    "Тебе доступны эти инструменты (аргументы — в их схемах):",
    ...lines,
    "Правила: факты бери из результата инструмента, а не из догадок; если инструмент вернул ошибку — " +
      "прочитай её, исправь аргументы или объясни человеку; недоступное для твоей роли действие не предлагай.",
  ].join("\n");
}
