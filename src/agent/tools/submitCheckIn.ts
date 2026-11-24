/**
 * `submit_check_in` — child (SPEC §5.4).
 *
 * The child reports «сделал» with notebook photos. Three effects, in order, and the order matters:
 * the check-in and its photo links are stored first, then the assignment moves `active →
 * in_review` through the status machine (`src/domain/status.ts`), then the verification is started
 * through the {@link VerifySpawner} seam — a failed start leaves a recorded report, never a lost
 * one.
 *
 * Only `active` accepts a report. In `in_review` the report is already with the parent/AI, and
 * amending photos is a separate flow (M2 wiring recomputes the verdict); in `done` there is
 * nothing to report. Both cases answer with what to do instead, not with a domain error.
 */

import { nextAssignmentStatus } from "../../domain/status.js";
import type { Assignment, Photo, Repos } from "../../domain/index.js";
import { ASSIGNMENT_STATUS_RU, photoCount } from "./format.js";
import { defineDomainTool, ToolRefusal } from "./tool.js";

/** Why this assignment cannot take a report right now, in the child's own terms. */
function refusalFor(assignment: Assignment): ToolRefusal {
  if (assignment.status === "done") {
    return new ToolRefusal(
      `Задание «${assignment.subject}» уже сдано — отчёт по нему больше не нужен. Если нужно что-то пересдать, попроси родителя завести новое задание.`,
    );
  }
  return new ToolRefusal(
    `По заданию «${assignment.subject}» отчёт уже отправлен: оно ${ASSIGNMENT_STATUS_RU[assignment.status]} и ждёт решения родителя. ` +
      "Дополнить фото к уже отправленному отчёту пока нельзя — если нужно пересдать, попроси родителя отклонить вердикт.",
  );
}

/** Photos must exist before a check-in is created: a report nobody can look at is worse than none. */
async function loadPhotos(repos: Pick<Repos, "photos">, photoIds: readonly string[]): Promise<Photo[]> {
  const found: Photo[] = [];
  const missing: string[] = [];
  for (const id of photoIds) {
    const photo = await repos.photos.get(id);
    if (photo === null) missing.push(id);
    else found.push(photo);
  }
  if (missing.length > 0) {
    throw new ToolRefusal(
      `Не нашёл фото с id: ${missing.join(", ")}. Отчёт не создан — проверь, что фото приложены к сообщению, и попробуй снова.`,
    );
  }
  return found;
}

export const submitCheckInTool = defineDomainTool({
  name: "submit_check_in",
  title: "отчёт о выполнении",
  description:
    "Отчёт ребёнка о выполненном задании с фото тетради: задание переходит на проверку, запускается AI-проверка. " +
    "Вызывай, когда ребёнок говорит «сделал» и прикладывает фото. Комментарий необязателен («№13 не уверен»). " +
    "Вердикт после этого черновой: его ещё утверждает родитель.",
  argsHint:
    "assignment_id — id задания из list_assignments, photo_ids — id фото тетради (1–10, обязательны), " +
    "comment — короткая заметка ребёнка.",
  run: async (run, args) => {
    const assignment = await run.repos.assignments.get(args.assignment_id);
    if (assignment === null) {
      throw new ToolRefusal(
        `Не нашёл задание с id ${args.assignment_id}. Посмотри список через list_assignments и возьми id оттуда — отчёт не отправлен.`,
      );
    }

    // The status machine decides, not this tool: `report` exists only from `active`.
    const next = nextAssignmentStatus(assignment.status, "report");
    if (next === null) throw refusalFor(assignment);

    const attached = await loadPhotos(run.repos, args.photo_ids);

    const checkIn = await run.repos.checkIns.create({
      assignment_id: assignment.id,
      child_user_id: run.actor.userId,
      comment: args.comment ?? null,
    });
    for (const photo of attached) await run.repos.photos.attachToCheckIn(checkIn.id, photo.id);
    const updated = await run.repos.assignments.setStatus(assignment.id, next);

    const lines = [
      `Отчёт по «${updated.subject}» принят (${photoCount(attached.length)}), задание теперь ${ASSIGNMENT_STATUS_RU[updated.status]}.`,
    ];
    if (checkIn.comment !== null && checkIn.comment.trim() !== "") {
      lines.push(`Комментарий записан: «${checkIn.comment}».`);
    }

    try {
      await run.spawnVerify.startVerify({ checkInId: checkIn.id });
      lines.push("Проверка запущена: вердикт появится после неё и сначала будет черновым, пока родитель его не утвердит.");
    } catch {
      // The report is already stored; the honest answer is «проверка не стартовала», not a lost check-in.
      lines.push(
        "Проверку запустить не удалось — отчёт сохранён, задание ждёт проверки. Попробуй позже или скажи родителю.",
      );
    }
    lines.push(`id отчёта: ${checkIn.id}`);
    return lines.join("\n");
  },
});
