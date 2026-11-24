/**
 * The decision half of the verification lifecycle (SPEC §5.4), shared by
 * `approve_verification` and `dismiss_verification`.
 *
 * Both tools do the same three things and differ only in the direction:
 *
 * 1. the verification must still be a `draft` — a decided one is terminal (SPEC §5.4: «оба
 *    терминальны»), so a second decision is answered with «уже решено», not rewritten;
 * 2. `VerificationsRepo.decide` records the verdict, the deciding parent and the instant;
 * 3. the assignment follows the journal decision (`src/domain/status.ts`): approve →
 *    `in_review → done`, dismiss → `in_review → active`. Dismissing returns the assignment to
 *    work on purpose: the parent rejected the AI verdict, not the child's work, so the report
 *    stays on record and can be redone.
 *
 * If the assignment is not in `in_review` any more (a stale draft after a dismiss, a reassigned
 * id), the tool says so and changes only the verification — never forcing an illegal transition.
 */

import { nextAssignmentStatus } from "../../domain/status.js";
import type { AssignmentAction } from "../../domain/status.js";
import type { VerificationStatus } from "../../domain/types.js";
import { ASSIGNMENT_STATUS_RU, VERIFICATION_STATUS_RU, formatDayTime } from "./format.js";
import { ToolRefusal } from "./tool.js";
import type { ToolRun } from "./tool.js";

/** What the parent decided. Also the stored `verifications.status` value. */
export type VerificationDecision = Extract<VerificationStatus, "approved" | "dismissed">;

const ASSIGNMENT_ACTION: Record<VerificationDecision, AssignmentAction> = {
  approved: "approve",
  dismissed: "dismiss",
};

/** Apply one decision and answer in the words the parent used («утвердил» / «отклонил»). */
export async function applyVerificationDecision(
  run: ToolRun,
  verificationId: string,
  decision: VerificationDecision,
  reason?: string,
): Promise<string> {
  const verification = await run.repos.verifications.getWithFindings(verificationId);
  if (verification === null) {
    throw new ToolRefusal(
      `Не нашёл вердикт с id ${verificationId}. Возможно, id неверный — посмотри список через get_verdicts. Ничего не изменено.`,
    );
  }
  if (verification.status !== "draft") {
    throw new ToolRefusal(
      `Вердикт уже решён: ${VERIFICATION_STATUS_RU[verification.status]}` +
        `${verification.decided_at === null ? "" : `, ${formatDayTime(verification.decided_at)}`}. Ничего не меняю.`,
    );
  }

  await run.repos.verifications.decide(verificationId, decision, run.actor.userId, run.now);

  const checkIn = await run.repos.checkIns.get(verification.checkin_id);
  const assignment = checkIn === null ? null : await run.repos.assignments.get(checkIn.assignment_id);

  if (assignment === null) {
    return decision === "approved"
      ? "Вердикт утверждён. Задание по этому отчёту не найдено, поэтому его статус не менял."
      : "Вердикт отклонён. Задание по этому отчёту не найдено, поэтому его статус не менял.";
  }

  const next = nextAssignmentStatus(assignment.status, ASSIGNMENT_ACTION[decision]);
  const lines: string[] = [];
  if (next === null) {
    lines.push(
      `Вердикт ${decision === "approved" ? "утверждён" : "отклонён"}. Статус задания не менял: оно ${ASSIGNMENT_STATUS_RU[assignment.status]}, переход не нужен.`,
    );
  } else {
    const updated = await run.repos.assignments.setStatus(assignment.id, next);
    lines.push(
      decision === "approved"
        ? `Вердикт утверждён: «${updated.subject}» — сдано.`
        : `Вердикт отклонён: «${updated.subject}» снова ждёт отчёта.`,
    );
    lines.push(
      decision === "approved"
        ? "Ребёнок теперь увидит вердикт: он утверждён и больше не изменится."
        : "Отчёт сохранён: ребёнок может дополнить фото или пересдать задание.",
    );
  }
  if (reason !== undefined) lines.push(`Причину родитель назвал так: «${reason}».`);
  return lines.join("\n");
}
