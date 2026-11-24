/**
 * Message templates (RU) for the two broadcasts of SPEC §5.6 and the user's test message.
 *
 * Every function is pure: given the same data it returns the same text, no clock, no I/O, no
 * timezone logic. Dates are formatted by the caller (the durable task knows the family's TZ) and
 * arrive as ready strings; the templates only lay them out.
 *
 * Two rendering rules the whole module follows:
 * 1. **All data is escaped** through `escapeHtml` — the client sends `parse_mode: "HTML"`, so a
 *    subject like «a < b» would otherwise break the message.
 * 2. **Empty sections disappear.** A reminder with nothing due is `null` (send nothing), and a
 *    digest keeps only the sections that have entries. The digest's last line is always `hmwrk`.
 */

import { escapeHtml } from "./bindings.js";

/**
 * One line of a broadcast. Deliberately loose and structural: N1 can pass its own DTOs, an
 * `Assignment`, or an `AssignmentItem`-derived object without an adapter.
 */
export interface NotifyEntry {
  /** Assignment subject, e.g. «Математика». Escaped by the template. */
  readonly subject: string;
  /** Item label, e.g. «№ 12» / «упр. 3». */
  readonly label?: string | null;
  /** Free-form suffix supplied by the task (e.g. «дедлайн 24.11 20:00»). */
  readonly detail?: string | null;
  /** Alias of `detail`, so a raw assignment row with `due_at` can be passed as is. */
  readonly due_at?: string | null;
}

/** Input of {@link renderReminder} — «завтра сдать». */
export interface ReminderInput {
  readonly items: readonly NotifyEntry[];
  /** Already formatted date of the due day («26.11»); omitted → heading without a date. */
  readonly date?: string | null;
}

/** Input of {@link renderDigest} — the four parent sections of SPEC §5.6. */
export interface DigestInput {
  /** Already formatted date («26.11»); omitted → heading without a date. */
  readonly date?: string | null;
  /** «что сдано сегодня». */
  readonly completedToday: readonly NotifyEntry[];
  /** «что просрочено». */
  readonly overdue: readonly NotifyEntry[];
  /** «какие вердикты ждут утверждения». */
  readonly pendingVerdicts: readonly NotifyEntry[];
  /** «что пришло от парсера скриншотов на подтверждение». */
  readonly pendingParses: readonly NotifyEntry[];
}

/** Input of {@link renderTestMessage} — the user's checklist message. */
export interface TestMessageInput {
  /** Role of the chat the message is sent to; rendered as a human word. */
  readonly role?: "parent" | "child";
  /** Chat id echoed back, so the user can compare it with @userinfobot. Escaped, shown as code. */
  readonly chatId?: string | null;
}

/** Signature line every broadcast ends with (SPEC §5.6 brand). */
const SIGNATURE = "hmwrk";

/** «математика №12, английский упр. 3» — subject + label, no escaping yet. */
function entryText(entry: NotifyEntry): string {
  const subject = entry.subject.trim();
  const label = entry.label?.trim() ?? "";
  const detail = (entry.detail ?? entry.due_at)?.trim() ?? "";
  const head = label === "" ? subject : `${subject} ${label}`;
  return detail === "" ? head : `${head} — ${detail}`;
}

function bulletList(entries: readonly NotifyEntry[]): string {
  return entries.map((entry) => `• ${escapeHtml(entryText(entry))}`).join("\n");
}

function heading(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

/**
 * «Завтра сдать: … — не забудь отчитаться в hmwrk».
 *
 * Returns `null` when there is nothing to remind about — the durable task then sends nothing
 * (an empty message would be rejected by Telegram as `invalid_input`).
 */
export function renderReminder(input: ReminderInput): string | null {
  if (input.items.length === 0) return null;

  const date = input.date?.trim();
  const title = date ? `Завтра сдать (${date})` : "Завтра сдать";
  const lines = [heading(title), "", bulletList(input.items), "", `Не забудь отчитаться в ${SIGNATURE}.`];
  return lines.join("\n");
}

/**
 * Parent digest: «сдано сегодня / просрочено / ждут утверждения / скриншоты на подтверждении».
 *
 * Empty sections are omitted; when all four are empty the digest says so in one line instead of
 * an empty heading. The last line is always `hmwrk`.
 */
export function renderDigest(input: DigestInput): string {
  const date = input.date?.trim();
  const lines: string[] = [heading(date ? `Итоги дня (${date})` : "Итоги дня")];

  const sections: ReadonlyArray<readonly [string, readonly NotifyEntry[]]> = [
    ["Сдано сегодня", input.completedToday],
    ["Просрочено", input.overdue],
    ["Ждут утверждения", input.pendingVerdicts],
    ["Скриншоты на подтверждении", input.pendingParses],
  ];

  const rendered = sections.filter(([, entries]) => entries.length > 0);
  if (rendered.length === 0) {
    lines.push("", "Сегодня всё спокойно: новых отчётов, просрочек и черновиков нет.");
  }
  for (const [title, entries] of rendered) {
    lines.push("", heading(title), bulletList(entries));
  }

  lines.push("", SIGNATURE);
  return lines.join("\n");
}

/**
 * Test message for the setup checklist (`docs/telegram-setup.md`): proves the token, the chat
 * binding and outbound delivery in one step. Safe to send from the CLI by hand.
 */
export function renderTestMessage(input: TestMessageInput = {}): string {
  const chat = input.chatId?.trim();
  const role =
    input.role === undefined ? "" : ` Роль: ${input.role === "parent" ? "родитель" : "ребёнок"}.`;
  const chatLine = chat === undefined || chat === "" ? "" : `\nchat_id: <code>${escapeHtml(chat)}</code>`;
  return [
    heading("hmwrk: проверка связи"),
    "",
    `Это тестовое сообщение — рассылки настроены.${role}${chatLine}`,
    "",
    SIGNATURE,
  ].join("\n");
}
