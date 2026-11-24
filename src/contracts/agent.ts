/**
 * Module contract: how the agent skeleton is assembled, implemented by A1 in `src/agent/**`.
 *
 * A1 owns the prompt text and the extension object; this file fixes only the seams:
 *
 * - the extension name S1 installs into the registry and `AgentState.extensions` can select;
 * - the dependency bundle the extension factory receives (role source, clock, M2 tool slot);
 * - the canonical tool-name list from SPEC §5.5, so M2 tools cannot drift from the prompt;
 * - the zod → JSON Schema bridge that K7 settled for tool arguments.
 *
 * Why the role does not arrive as a constructor argument: one registry serves every
 * conversation, and the prompt section renders per request with only a `PromptInput`
 * (`conversationId`, `agent`, `read`). The role therefore comes from S1's
 * {@link ActorDirectory} at render time, keyed by `input.conversationId` (K3).
 */

import type {
  ConversationId,
  Extension,
  PromptSection,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { z } from "zod";
import type { ModelsConfig } from "../config/index.js";
import type { IsoDate, Repos, Role } from "../domain/index.js";
import type { ActorDirectory } from "./harness.js";

// ---------------------------------------------------------------------------
// Names the registry, the prompt and M2 agree on
// ---------------------------------------------------------------------------

/** Extension name (SPEC §6 shows one model, `hmwrk`); S1 installs it, A1 defines it. */
export const AGENT_EXTENSION_NAME = "hmwrk";

/**
 * Key of A1's system-prompt section inside the `hmwrk` extension. `wrapSection()` (M2) targets
 * sections by this key, so it is part of the contract rather than a local constant.
 */
export const AGENT_SECTION_KEY = "hmwrk.role-and-date";

/**
 * The single tool list of SPEC §5.5, in the order the prompt should present it. M2 implements
 * them; M1's skeleton declares none (the prompt says so honestly).
 *
 * Role permissions (SPEC §4) are enforced by the tools themselves (A2): parent-only
 * `parse_screenshot`, `manual_add_assignment`, `approve_verification`, `dismiss_verification`,
 * `set_setting`; child-only `submit_check_in`; both roles `list_assignments`, `get_verdicts`,
 * `get_settings`.
 */
export const TOOL_NAMES = [
  "list_assignments",
  "parse_screenshot",
  "manual_add_assignment",
  "submit_check_in",
  "get_verdicts",
  "approve_verification",
  "dismiss_verification",
  "get_settings",
  "set_setting",
] as const;

/** One of SPEC §5.5's tools. */
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * M2 attachment point: implementations keyed by {@link ToolName}. Partial on purpose — M1 has
 * none, M2 fills them incrementally, and a missing entry simply means "not offered/not wired".
 */
export type AgentToolset = Partial<Record<ToolName, ToolRegistration>>;

// ---------------------------------------------------------------------------
// What the prompt section needs per request
// ---------------------------------------------------------------------------

/** The per-request facts A1's section renders (SPEC §6: role, current assignments, date format). */
export interface AgentPromptContext {
  readonly userId: string;
  readonly role: Role;
  /** Household-local calendar day, `YYYY-MM-DD` — the format dates are shown in (SPEC §5.7). */
  readonly today: IsoDate;
  /** Instant `today` was derived from; A1 formats it, the contract does not. */
  readonly now: Date;
}

/** Empty-agent wording marker for M1: the prompt must say the domain tools are not connected. */
export type AgentCapabilities =
  /** M1 skeleton: no tools, echo/talk only. */
  | { readonly kind: "skeleton" }
  /** M2+: tools wired; the list is exactly what the prompt advertises. */
  | { readonly kind: "tools"; readonly tools: readonly ToolName[] };

/** Everything A1's extension factory may depend on. */
export interface AgentDeps {
  /**
   * K3: role lookup by `conversationId` (S1's `Core.actors`). The section calls
   * `get(input.conversationId)` on every render — one registry for all conversations.
   */
  readonly actors: ActorDirectory;
  /** SPEC §7 slots; M1 uses none, M2 tools read `read`/`verify` here. */
  readonly models: ModelsConfig;
  /** Household clock; default `() => new Date()`. Injected so tests can pin the date. */
  readonly now?: () => Date;
  /** M2: tool implementations by SPEC §5.5 name. Absent in M1. */
  readonly tools?: AgentToolset;
  /** M2: data access for the tools (T1's repository contracts, D2 implements them). */
  readonly repos?: Repos;
  /** What the prompt may promise the model; default `{ kind: "skeleton" }` for M1. */
  readonly capabilities?: AgentCapabilities;
}

/**
 * Shape A1 exports as `renderAgentPrompt` from `src/agent/prompt.ts`: the RU system-prompt text
 * for one request. `capabilities` decides whether it claims tools (M2) or says it is a skeleton
 * (M1). This is the only seam through which role and date enter the prompt.
 */
export type AgentPromptRenderer = (ctx: AgentPromptContext, capabilities: AgentCapabilities) => string;

/** Shape A1 exports as `createAgentExtension` from `src/agent/extension.ts`. */
export type AgentExtensionFactory = (deps: AgentDeps) => Extension;

/** Shape of one section's render function, for A1's helpers and tests. */
export type AgentSectionRender = PromptSection["render"];

/** Convenience alias used by A1 when typing a section it builds. */
export type AgentSection = PromptSection;

// ---------------------------------------------------------------------------
// K7: tool argument schemas
// ---------------------------------------------------------------------------

/**
 * K7 verdict: durable takes **JSON Schema** in `ToolRegistration.parameters` and validates it
 * with pi-schema (`coerce: true`), so a wrong-typed argument becomes a human-readable
 * `<harness>[error] …</harness>` result for the model — we do not hand-write validation.
 *
 * zod stays the authoring language (SPEC §5.5, zod 4 is already a dependency):
 * `z.toJSONSchema(z.strictObject({...}), { io: "input" })`. Use `z.strictObject` for tool
 * arguments — it emits `additionalProperties: false`; plain `z.object()` stays open.
 */
export function toToolParameters(
  schema: z.ZodType,
  options?: { readonly io?: "input" | "output" },
): Record<string, unknown> {
  throw new Error("Not implemented: contract only");
}

// ---------------------------------------------------------------------------
// Re-exports used to type A1's factory without reaching into pi-durable
// ---------------------------------------------------------------------------

/** `Extension` as installed by S1 (re-exported for A1's return type). */
export type AgentExtension = Extension;
/** `ConversationId` as it arrives in `PromptInput` (re-exported for A1's helper signatures). */
export type AgentConversationId = ConversationId;
