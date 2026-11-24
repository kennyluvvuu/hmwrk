/**
 * N1 ⇄ G1T bridge: the durable tasks' DTOs in, the RU message templates out (I3).
 *
 * N1 deliberately knows nothing about Telegram types (`renderReminder` / `renderDigest` are injected,
 * see `src/durable/tasks/notify.ts`), and G1T's templates know nothing about repositories — they take
 * an already formatted list of entries. This module is that seam and nothing else: it maps
 * `AssignmentWithItems` / `DigestSections` onto {@link NotifyEntry} and formats the two dates the
 * templates show. It performs no I/O, so a missing field can never make a broadcast fail late.
 *
 * Formatting is local-time (the same clock `reminder_time`, `due_at` and `paused_until` use). The
 * helpers are intentionally local instead of importing `src/agent/tools/format.ts`: the Telegram module
 * must not depend on the agent module (it is a channel, not a conversation participant), and the two
 * formats are one line each.
 */

import { formatIsoDate, formatTimeOfDay, fromIso } from "../domain/dates.js";
import type { Assignment, AssignmentWithItems, IsoDateTime } from "../domain/index.js";
import type { DigestRenderer, DigestSections, ReminderRenderer } from "../durable/tasks/notify.js";
import { renderDigest, renderReminder, type NotifyEntry } from "./templates.js";

/** `25.11.2026` — the local calendar day of an instant. */
function day(iso: IsoDateTime): string {
  const [year, month, date] = formatIsoDate(fromIso(iso)).split("-");
  return `${date}.${month}.${year}`;
}

/** `25.11.2026 20:00` — the local day and wall-clock time of a due instant. */
function dayTime(iso: IsoDateTime): string {
  return `${day(iso)} ${formatTimeOfDay(fromIso(iso))}`;
}

/** `№ 12, № 13` — an assignment's items as one line, or nothing when it has none. */
function itemsLabel(items: readonly { label: string }[]): string | null {
  const labels = items.map((item) => item.label.trim()).filter((label) => label !== "");
  return labels.length === 0 ? null : labels.join(", ");
}

/** The earliest due instant of the reminder list: what the heading dates («Завтра сдать (26.11…)»). */
function earliestDue(assignments: readonly AssignmentWithItems[]): string | null {
  let earliest: number | undefined;
  for (const assignment of assignments) {
    const due = fromIso(assignment.due_at).getTime();
    if (earliest === undefined || due < earliest) earliest = due;
  }
  return earliest === undefined ? null : day(new Date(earliest).toISOString());
}

/**
 * Child reminder (SPEC §5.6): one bullet per assignment — subject, items, deadline.
 *
 * Returns `""` for an empty list, which N1 reads as «nothing to send» (the template's `null`).
 */
export const renderReminderMessage: ReminderRenderer = (assignments) => {
  const items: NotifyEntry[] = assignments.map((assignment) => ({
    subject: assignment.subject,
    label: itemsLabel(assignment.items),
    detail: `к ${dayTime(assignment.due_at)}`,
  }));
  return renderReminder({ items, date: earliestDue(assignments) }) ?? "";
};

/** One digest bullet for an assignment without its items (the digest DTO carries plain rows). */
function assignmentEntry(assignment: Assignment, detail: string): NotifyEntry {
  return { subject: assignment.subject, detail };
}

/**
 * Parent digest (SPEC §5.6): «сдано сегодня / просрочено / ждут утверждения / скриншоты на
 * подтверждении». Empty sections disappear inside the template, so an otherwise quiet evening is one
 * line, not four empty headings.
 */
export const renderDigestMessage: DigestRenderer = (sections: DigestSections) =>
  renderDigest({
    completedToday: sections.submittedToday.map(({ assignment, checkIn }) =>
      assignmentEntry(assignment, checkIn.comment?.trim() || "отчёт получен"),
    ),
    overdue: sections.overdue.map((assignment) => assignmentEntry(assignment, `дедлайн ${dayTime(assignment.due_at)}`)),
    pendingVerdicts: sections.pendingVerdicts.map(({ verification, assignment }) => ({
      subject: assignment?.subject ?? "задание",
      detail: verification.summary.trim() || "черновик вердикта",
    })),
    pendingParses: sections.parserDrafts.map((assignment) => assignmentEntry(assignment, "скриншот ждёт подтверждения")),
  });

/** Both renderers as N1's dependency shape: `createNotifyExtension({ ...renderers })`. */
export function createNotifyRenderers(): {
  readonly renderReminder: ReminderRenderer;
  readonly renderDigest: DigestRenderer;
} {
  return { renderReminder: renderReminderMessage, renderDigest: renderDigestMessage };
}
