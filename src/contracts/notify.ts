/**
 * Module contract: outbound Telegram notification seam (SPEC §5.6, G1T).
 *
 * The notification tasks (N1) and the e2e run (I3) talk to Telegram only through this
 * interface: one method, one request kind. The MVP sends text only — no edits, no media,
 * no polling, no webhooks — so the surface stays a single `sendMessage`.
 *
 * Error policy (implemented by `src/telegram/client.ts`): a failed send throws; the
 * sender never retries on its own, because whether a reminder/digest is worth retrying
 * is a scheduling decision of the durable task that owns it.
 */

/** Отправка исходящего сообщения (SPEC 5.6: sendMessage only). */
export interface TelegramSender {
  sendMessage(input: { chatId: string; text: string }): Promise<void>;
}
