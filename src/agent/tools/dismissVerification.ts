/**
 * `dismiss_verification` — parent (SPEC §5.4, journal §7 W1).
 *
 * The parent disagrees with the AI: verification `draft → dismissed`, assignment
 * `in_review → active`. Returning the assignment to `active` is the recorded decision: the parent
 * rejected the verdict, not the child's work, so the report stays and the assignment is back in
 * the reminder/digest loop where the child can redo it.
 *
 * `reason` is the parent's own words; the domain has no field for it (SPEC §5.2), so it is echoed
 * back in the answer and stays in the conversation, not in the database.
 */

import { applyVerificationDecision } from "./decisions.js";
import { defineDomainTool } from "./tool.js";

export const dismissVerificationTool = defineDomainTool({
  name: "dismiss_verification",
  title: "отклонить вердикт",
  description:
    "Отклонить черновой вердикт: задание возвращается в работу и снова ждёт отчёта, отчёт остаётся на месте. " +
    "Вызывай, когда родитель не согласен с проверкой («неверно проверил», «это не ошибка»). Ребёнку результат " +
    "не показывается — задание просто снова активно.",
  argsHint: "verification_id — id черновика из get_verdicts, reason — причина словами родителя (необязательно).",
  run: async (run, args) => applyVerificationDecision(run, args.verification_id, "dismissed", args.reason),
});
