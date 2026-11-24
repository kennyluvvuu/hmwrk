/**
 * `approve_verification` — parent (SPEC §5.4).
 *
 * Turns a draft verdict into the result the child may see: verification `draft → approved` and the
 * assignment `in_review → done` (terminal). Only the parent can do this — the AI verdict is never
 * final on its own (ADR 0002), which is why the tool is refused to the child by
 * {@link import("./tool.js").createToolRegistration}.
 */

import { applyVerificationDecision } from "./decisions.js";
import { defineDomainTool } from "./tool.js";

export const approveVerificationTool = defineDomainTool({
  name: "approve_verification",
  title: "утвердить вердикт",
  description:
    "Утвердить черновой вердикт проверки: задание становится сданным, ребёнок видит результат. Вызывай только " +
    "после явного согласия родителя с вердиктом («да, всё верно», «утверждаю»). После утверждения вердикт " +
    "не меняется.",
  argsHint: "verification_id — id вердикта из get_verdicts (черновика).",
  run: async (run, args) => applyVerificationDecision(run, args.verification_id, "approved"),
});
