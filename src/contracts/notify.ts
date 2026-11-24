/**
 * Module contract: outbound Telegram messages (SPEC §5.6). Written by G1T in W7; fixed here because
 * the durable reminder/digest tasks (N1) send through it and must not import `src/telegram/**`.
 *
 * The bot only ever pushes text: no incoming updates, no long polling (SPEC §2, §5.6).
 */

/** Bot API delivery seam. Implemented by the G1T Telegram client; a fake in tests. */
export interface TelegramSender {
  sendMessage(input: { chatId: string; text: string }): Promise<void>;
}
