/**
 * RU rendering shared by the nine tools: dates, statuses and verdicts as a person reads them.
 *
 * All formatting is local-time on purpose (SPEC §5.7: `default_due` and `reminder_time` mean the
 * household's wall clock), and dates are shown as `25.11.2026` — the format SPEC §6 fixes for the
 * prompt. Nothing here is allowed to throw on a stored value: tools render whatever the store
 * returned, the validation happened on the way in.
 */

import { asDate, formatIsoDate, formatTimeOfDay } from "../../domain/dates.js";
import type {
  AssignmentStatus,
  FindingVerdict,
  IsoDate,
  IsoDateTime,
  Role,
  VerificationStatus,
} from "../../domain/types.js";

/** SPEC §4 role names («Родитель» / «Ребёнок»). */
export const ROLE_TITLE_RU: Record<Role, string> = {
  parent: "Родитель",
  child: "Ребёнок",
};

/** Assignment status (SPEC §5.1) in the words a parent uses. */
export const ASSIGNMENT_STATUS_RU: Record<AssignmentStatus, string> = {
  active: "ждёт отчёта",
  in_review: "на проверке",
  done: "сдано",
};

/** Verification lifecycle as it reads to the model deciding what to say next. */
export const VERIFICATION_STATUS_RU: Record<VerificationStatus, string> = {
  draft: "черновик (ждёт решения родителя)",
  approved: "утверждён",
  dismissed: "отклонён",
};

/** Per-item verdicts (SPEC §5.4); `unclear` is an honest «не разобрал», not a failure. */
export const FINDING_VERDICT_RU: Record<FindingVerdict, string> = {
  ok: "верно",
  wrong: "ошибка",
  missing: "не найдено",
  unclear: "не разобрал",
};

/** `25.11.2026` — a local calendar day of an instant or of an `IsoDate`. */
export function formatDay(value: Date | IsoDateTime | IsoDate): string {
  // `IsoDate` is already a calendar day: parsing it as an instant would shift it by the UTC offset.
  const iso = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : formatIsoDate(asDate(value));
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

/** `25.11.2026 20:00` — local day and wall-clock time of a due instant. */
export function formatDayTime(value: Date | IsoDateTime): string {
  return `${formatDay(value)} ${formatTimeOfDay(asDate(value))}`;
}

/** `2 пункта` / `5 пунктов` — count with the right RU word. */
export function itemCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "пункт"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "пункта"
        : "пунктов";
  return `${count} ${word}`;
}

/** `2 фото` / `5 фото` — same idea for photos (invariant form). */
export function photoCount(count: number): string {
  return `${count} фото`;
}
