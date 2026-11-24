/**
 * `manual_add_assignment` — parent (SPEC §5.3, §5.7).
 *
 * The working intake channel of the MVP: the parent dictates «математика, №12–14, к 25.11» and the
 * agent resolves the human phrase into arguments (turning words into dates is the *agent's* job,
 * see `src/domain/dates.ts`), while this tool does the domain part:
 *
 * - due precedence: `due_at` (exact instant) → `due_date` (day at `settings.default_due.time`) →
 *   `settings.default_due` itself (default «завтра 20:00», SPEC §5.7);
 * - creation is immediate activation (`source: manual`, status `active`) — SPEC §5.3 explicitly
 *   does not keep parsing drafts, confirmation *is* creation.
 */

import { atLocalTime, dueFromDefault, fromIso, parseIsoDate, toIso } from "../../domain/dates.js";
import { InvalidValueError } from "../../domain/errors.js";
import { formatDefaultDue } from "../../domain/settings.js";
import type { DefaultDue, NewAssignmentItemInput, Settings, ToolArgs } from "../../domain/index.js";
import { ASSIGNMENT_STATUS_RU, formatDayTime, itemCount } from "./format.js";
import { defineDomainTool, ToolRefusal } from "./tool.js";

type ItemArg = ToolArgs<"manual_add_assignment">["items"][number];

/** `"№12"` and `{ label, note }` both become the repository's item input. */
function toItemInput(item: ItemArg): NewAssignmentItemInput {
  if (typeof item === "string") return { label: item.trim() };
  return { label: item.label.trim(), ...(item.note === undefined ? {} : { note: item.note }) };
}

/** What the tool resolved the due from, so the answer can say why the deadline is that one. */
interface ResolvedDue {
  readonly due: Date;
  readonly explanation: string;
}

function resolveDue(args: ToolArgs<"manual_add_assignment">, settings: Settings, now: Date): ResolvedDue {
  if (args.due_at !== undefined) {
    return { due: fromIso(args.due_at), explanation: "дедлайн из аргумента" };
  }
  if (args.due_date !== undefined) {
    let due: Date;
    try {
      due = atLocalTime(parseIsoDate(args.due_date), settings.default_due.time);
    } catch (error) {
      const detail = error instanceof InvalidValueError ? error.message : String(error);
      throw new ToolRefusal(`Не понял дату «${args.due_date}»: нужен формат ГГГГ-ММ-ДД. (${detail})`);
    }
    return { due, explanation: `день ${args.due_date}, время из настройки default_due (${settings.default_due.time})` };
  }
  const rule: DefaultDue = settings.default_due;
  return { due: dueFromDefault(now, rule), explanation: `дедлайн по умолчанию — ${formatDefaultDue(rule)}` };
}

export const manualAddAssignmentTool = defineDomainTool({
  name: "manual_add_assignment",
  title: "добавить задание",
  description:
    "Создать задание вручную: предмет, пункты и дедлайн. Вызывай, когда родитель называет задание словами — " +
    "«добавь математику, №12–14, к 25.11». Задание сразу активное: ребёнку оно видно в списке и ждёт отчёта. " +
    "Без даты дедлайн берётся из настройки default_due (по умолчанию завтра 20:00).",
  argsHint:
    "subject — предмет, items — пункты (строка «№12» или {label, note}), due_at (точный ISO-момент) ЛИБО " +
    "due_date (ГГГГ-ММ-ДД, не обе даты сразу), note — заметка ко всему заданию.",
  run: async (run, args) => {
    const settings = await run.repos.settings.getAll();
    const { due, explanation } = resolveDue(args, settings, run.now);

    const created = await run.repos.assignments.create({
      subject: args.subject.trim(),
      due_at: toIso(due),
      source: "manual",
      note: args.note ?? null,
      items: args.items.map(toItemInput),
    });

    const lines = [`Добавил задание: «${created.subject}» — к ${formatDayTime(created.due_at)} (${explanation}).`];
    lines.push(`Пункты (${itemCount(created.items.length)}): ${created.items.map((item) => item.label).join(", ")}.`);
    if (created.note !== null && created.note.trim() !== "") lines.push(`Заметка: ${created.note}`);
    if (due.getTime() < run.now.getTime()) {
      lines.push("Дедлайн уже прошёл, поэтому задание сразу видно как просроченное.");
    }
    lines.push(`Статус: ${ASSIGNMENT_STATUS_RU[created.status]}. id: ${created.id}`);
    return lines.join("\n");
  },
});
