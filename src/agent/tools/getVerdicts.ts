/**
 * `get_verdicts` — both roles, different slices (SPEC §4, §5.4).
 *
 * The parent sees every verification, drafts included: a draft is exactly what waits for their
 * decision, so hiding it would hide the queue. The child sees approved verdicts only — SPEC §5.4
 * makes the parent the final instance, so a draft shown to the child would be a result that may
 * still change.
 *
 * The role decides the status filter, not the argument: `status` narrows what the caller may
 * already see, it can never widen it.
 */

import type { Assignment, Repos, Role, Verification, VerificationStatus } from "../../domain/index.js";
import { FINDING_VERDICT_RU, VERIFICATION_STATUS_RU, formatDayTime } from "./format.js";
import { defineDomainTool } from "./tool.js";

type VerdictsArgs = { assignment_id?: string; status?: VerificationStatus | "all" };

/** Requested statuses after the role's own limit is applied. */
function statusesFor(role: Role, requested: VerdictsArgs["status"]): readonly VerificationStatus[] | undefined {
  // SPEC §4: the child's column says «только утверждённые», whatever the argument says.
  if (role === "child") return ["approved"];
  if (requested === undefined || requested === "all") return undefined;
  return [requested];
}

/** Walk verification → check-in → assignment; either hop may be gone after a cascade. */
async function assignmentOf(repos: Repos, verification: Verification): Promise<Assignment | null> {
  const checkIn = await repos.checkIns.get(verification.checkin_id);
  return checkIn === null ? null : repos.assignments.get(checkIn.assignment_id);
}

/** One verdict block: what was checked, when, by which model, the summary and per-item findings. */
async function renderVerdict(repos: Repos, verification: Verification): Promise<string> {
  const assignment = await assignmentOf(repos, verification);
  const subject = assignment === null ? "задание не найдено" : `«${assignment.subject}»`;
  const lines = [
    `• ${subject} — ${VERIFICATION_STATUS_RU[verification.status]} — проверка от ${formatDayTime(verification.created_at)}, модель ${verification.model}`,
    `   резюме: ${verification.summary}`,
  ];

  for (const finding of await repos.verifications.findings(verification.id)) {
    const item = await repos.assignments.getItem(finding.item_id);
    const label = item === null ? `пункт ${finding.item_id.slice(0, 8)}` : item.label;
    const comment = finding.comment === null || finding.comment.trim() === "" ? "" : ` — «${finding.comment}»`;
    lines.push(`   — ${label}: ${FINDING_VERDICT_RU[finding.verdict]}${comment}`);
  }

  if (verification.decided_at !== null) {
    lines.push(`   решение: ${formatDayTime(verification.decided_at)}`);
  }
  lines.push(`   id: ${verification.id}`);
  return lines.join("\n");
}

export const getVerdictsTool = defineDomainTool({
  name: "get_verdicts",
  title: "вердикты проверок",
  description:
    "Вердикты AI-проверок отчётов. Родитель видит все, включая черновики (их он и утверждает); ребёнок — только " +
    "утверждённые. Вызывай на вопросы «что там по проверке», «проверили?», перед утверждением или отклонением.",
  argsHint:
    "assignment_id — сузить до одного задания, status — draft, approved, dismissed или all " +
    "(родителю; ребёнку всегда только approved).",
  run: async (run, args) => {
    const statuses = statusesFor(run.actor.role, args.status);

    if (args.assignment_id !== undefined) {
      const assignment = await run.repos.assignments.get(args.assignment_id);
      if (assignment === null) {
        return `Не нашёл задание с id ${args.assignment_id}: возможно, id неверный. Список заданий — list_assignments.`;
      }
    }

    const rows =
      args.assignment_id === undefined
        ? await run.repos.verifications.list(statuses === undefined ? {} : { status: statuses })
        : await run.repos.verifications.listByAssignment(
            args.assignment_id,
            statuses === undefined ? {} : { status: statuses },
          );

    if (rows.length === 0) {
      return run.actor.role === "child"
        ? "Утверждённых вердиктов пока нет. Черновик сначала утверждает родитель — до этого результата нет."
        : "Вердиктов нет: проверок ещё не было или под это условие ничего не подходит.";
    }

    const lines: string[] = [
      run.actor.role === "child" ? `Утверждённые вердикты (${rows.length}):` : `Вердикты (${rows.length}):`,
    ];
    for (const verification of rows) lines.push(await renderVerdict(run.repos, verification));

    if (run.actor.role === "child") {
      lines.push("Черновики ребёнку не показываются: их сначала утверждает родитель.");
    }
    return lines.join("\n");
  },
});
