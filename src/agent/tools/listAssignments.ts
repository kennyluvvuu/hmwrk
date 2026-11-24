/**
 * `list_assignments` — both roles (SPEC §4, §5.5).
 *
 * The one tool that answers «что задано», «что сдать», «что я не сдал». It lists the *working set*
 * by default — `active` (ждёт отчёта) and `in_review` (на проверке) — and derives `overdue` from
 * the clock instead of reading it from the store, because `overdue` is not a stored status
 * (SPEC §5.1).
 *
 * Role difference, as SPEC §4 words it: the parent may look at any slice of history
 * (`done`, `all`), the child is shown the current assignments only — asking for history returns
 * the working set with a sentence saying so, not an error.
 */

import { isOverdue } from "../../domain/dates.js";
import type { AssignmentStatus, AssignmentWithItems, Role } from "../../domain/types.js";
import { ASSIGNMENT_STATUS_RU, formatDayTime } from "./format.js";
import { defineDomainTool } from "./tool.js";

/** Enough to see a week of homework without turning the prompt into a wall of text. */
const DEFAULT_LIMIT = 20;

/** What «активные задания» means for the agent: still the family's business (SPEC §5.1). */
const WORKING_STATUSES: readonly AssignmentStatus[] = ["active", "in_review"];

/** How a requested `status` maps onto stored statuses. */
interface StatusPlan {
  /** Stored statuses to query; undefined = every stored status. */
  readonly statuses?: readonly AssignmentStatus[];
  /** `overdue` plan: query active rows, then keep the derived overdue ones. */
  readonly overdueOnly: boolean;
  /** Sentence appended to the answer when the role narrowed the request. */
  readonly note?: string;
}

function planFor(role: Role, requested: AssignmentStatus | "overdue" | "all" | undefined): StatusPlan {
  if (requested === "overdue") return { overdueOnly: true };

  if (role === "child") {
    const narrowed = requested === undefined || requested === "done" || requested === "all";
    return {
      statuses: narrowed ? WORKING_STATUSES : [requested],
      overdueOnly: false,
      ...(narrowed
        ? { note: "Ребёнку показываются текущие задания — те, что ждут отчёта или уже на проверке. Сданные задания смотрит родитель." }
        : {}),
    };
  }

  if (requested === undefined) return { statuses: WORKING_STATUSES, overdueOnly: false };
  if (requested === "all") return { statuses: undefined, overdueOnly: false };
  return { statuses: [requested], overdueOnly: false };
}

/** One assignment as several short lines: due, status, items, id the model needs for follow-ups. */
function renderAssignment(assignment: AssignmentWithItems, now: Date): string {
  const marks = [ASSIGNMENT_STATUS_RU[assignment.status]];
  if (isOverdue(assignment, now)) marks.push("просрочено");

  const lines = [`• «${assignment.subject}» — к ${formatDayTime(assignment.due_at)} — ${marks.join(", ")}`];
  if (assignment.items.length > 0) {
    lines.push(`   пункты: ${assignment.items.map((item) => item.label).join(", ")}`);
  }
  if (assignment.note !== null && assignment.note.trim() !== "") lines.push(`   заметка: ${assignment.note}`);
  lines.push(`   id: ${assignment.id}`);
  return lines.join("\n");
}

export const listAssignmentsTool = defineDomainTool({
  name: "list_assignments",
  title: "список заданий",
  description:
    "Список заданий с дедлайнами, пунктами и статусами. Вызывай, когда спрашивают «что задано», «что сдать», " +
    "«что я не сдал», «что на проверке», а также перед отчётом или при планировании дня. Просроченные задания " +
    "помечаются отдельно: они вычисляются по дедлайну, а не хранятся.",
  argsHint:
    "status — active (ждёт отчёта), in_review (на проверке), done (сдано), overdue (просрочено) или all; " +
    "по умолчанию active + in_review. subject — предмет, limit — сколько показать (1–100).",
  run: async (run, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const plan = planFor(run.actor.role, args.status);
    const filter = {
      ...(plan.statuses === undefined ? {} : { status: plan.statuses }),
      ...(args.subject === undefined ? {} : { subject: args.subject }),
    };

    let rows: AssignmentWithItems[];
    if (plan.overdueOnly) {
      // Derived state: the repository cannot filter it, the clock can (SPEC §5.1).
      const active = await run.repos.assignments.listWithItems({ ...filter, status: "active" });
      rows = active.filter((assignment) => isOverdue(assignment, run.now));
    } else {
      rows = await run.repos.assignments.listWithItems(filter);
    }

    if (rows.length === 0) {
      return plan.overdueOnly
        ? "Просроченных заданий нет: все дедлайны в порядке."
        : "Заданий нет: под это условие сейчас ничего не подходит.";
    }

    const shown = rows.slice(0, limit);
    const lines = [`Задания (${shown.length} из ${rows.length}):`];
    for (const assignment of shown) lines.push(renderAssignment(assignment, run.now));
    if (rows.length > shown.length) {
      lines.push(`Показал первые ${shown.length}. Сузь фильтр (subject/status) или увеличь limit, чтобы увидеть остальные.`);
    }
    if (plan.note !== undefined) lines.push(plan.note);
    return lines.join("\n");
  },
});
