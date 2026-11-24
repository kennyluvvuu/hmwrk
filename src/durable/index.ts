/**
 * Barrel of the durable facade (S1). The `Core` contract itself is in `src/contracts/harness.ts`;
 * this module adds what only the implementation can offer: extensions installation (A1/M2) and the
 * `shutdown()` helper for `src/index.ts` (K11).
 *
 * Only files under `src/durable/**` may import pi-durable (ADR 0002 risk #1); callers import this barrel
 * or the contracts, never the packages.
 */

export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_PARTIAL_INTERVAL_MS,
  buildModels,
  installExtensions,
  openHarnessCore,
  registryFor,
  shutdown,
  type ShutdownOptions,
} from "./harness.js";

export {
  UserConversationsDoc,
  conversationByUser,
  conversationModelRef,
  createActorDirectory,
  emptyUserConversationIndex,
  getOrCreateConversation,
  readUserConversationIndex,
  type ConversationDeps,
} from "./conversations.js";

export {
  abortConversation,
  assistantMessageText,
  echoAssistantMessage,
  echoTurn,
  liveGenerationText,
  settleSubmission,
  submitUserInput,
  watchText,
} from "./submit.js";
