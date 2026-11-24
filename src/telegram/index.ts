/**
 * Barrel for the Telegram module (G1T): outbound sender, chat bindings, RU templates.
 *
 * The sender type itself lives in `src/contracts/notify.ts` — durable tasks import the contract,
 * never this implementation.
 */

export * from "./bind.js";
export * from "./bindings.js";
export * from "./client.js";
export * from "./templates.js";
