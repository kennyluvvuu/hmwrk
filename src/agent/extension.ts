/**
 * The `hmwrk` extension: one system-prompt section, and (M2) the nine SPEC §5.5 tools.
 *
 * K1/K7 (see `docs/research/pi-api-notes.md`): an `Extension` is `{ name, tools?, sections?,
 * hooks?, wraps?, tasks? }`, built with `defineExtension()`, and installed into a registry that
 * the Harness reads. Everything the extension needs arrives through {@link AgentDeps} — one
 * extension object serves every conversation, so nothing per-person may be baked in here.
 *
 * Why the role is read at render time (T3's note in `src/contracts/agent.ts`): the prompt section
 * receives only a `PromptInput`, i.e. a `conversationId` and no person. {@link AgentDeps.actors}
 * maps that id to a role on every render (K3), which is also why this factory returns a plain
 * `Extension` rather than a role-parameterised family.
 *
 * M1 is the skeleton: {@link AgentDeps.tools} is absent, so the extension declares `tools: []`
 * and the prompt says the domain tools are not connected yet. M2 passes
 * `deps.tools`/`deps.capabilities` and both the tool list and the prompt grow without touching
 * this file's shape.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import {
  AGENT_EXTENSION_NAME,
  AGENT_SECTION_KEY,
  TOOL_NAMES,
  type AgentCapabilities,
  type AgentDeps,
  type AgentExtension,
  type AgentExtensionFactory,
  type ActorRecord,
  type AgentPromptContext,
  type ToolName,
} from "../contracts/index.js";
import { formatIsoDate } from "../domain/dates.js";
import type { Role } from "../domain/types.js";
import { renderAgentPrompt } from "./prompt.js";

/**
 * Least-privilege fallback: an unknown conversation renders the child prompt.
 *
 * The mapping is written in the same commit that creates a conversation (K3), so this is a
 * should-not-happen path. If it does happen, the child wording is the safe half — the model may
 * not promise approvals or settings changes it cannot perform.
 */
const FALLBACK_ROLE: Role = "child";

/**
 * The SPEC §5.5 tools actually implemented, in the contract's canonical order.
 *
 * This is M2's socket: A2 fills `deps.tools` per name, and whatever is present is installed as
 * this extension's tools. Missing entries are simply not offered (`AgentToolset` is `Partial`),
 * so M1 needs no edit and M2 needs no rewrite.
 */
export function resolveAgentTools(deps: AgentDeps): readonly ToolRegistration[] {
  const tools = deps.tools;
  if (tools === undefined) return [];
  return TOOL_NAMES.flatMap((name) => {
    const tool = tools[name];
    return tool === undefined ? [] : [tool];
  });
}

/** The SPEC §5.5 names that actually resolved to a tool, in canonical order. */
export function resolveToolNames(deps: AgentDeps): readonly ToolName[] {
  const tools = deps.tools;
  if (tools === undefined) return [];
  return TOOL_NAMES.filter((name) => tools[name] !== undefined);
}

/**
 * What the prompt may claim. An explicit `deps.capabilities` always wins; without it, a toolset
 * that produced at least one tool means "tools" and an empty one means "skeleton" (M1).
 */
export function resolveCapabilities(deps: AgentDeps): AgentCapabilities {
  if (deps.capabilities !== undefined) return deps.capabilities;
  const tools = resolveToolNames(deps);
  return tools.length === 0 ? { kind: "skeleton" } : { kind: "tools", tools };
}

/**
 * The section key actually installed, and the reason it is not `AGENT_SECTION_KEY` verbatim.
 *
 * `createRegistry().install()` validates keys against `/^[a-z][a-z0-9_-]*$/` — **no dots**
 * (`dist/harness/registry.js`, `validateExtension`), and `AGENT_SECTION_KEY` in
 * `src/contracts/agent.ts` is `"hmwrk.role-and-date"`. Deriving the installed key keeps one
 * source of truth: whatever T3's contract says, the registry gets a valid key. M2's
 * `wrapSection()` must target this value, which is why it is exported from `src/agent`.
 * Reported to the orchestrator (contracts are not A1's to edit): one-line fix in
 * `src/contracts/agent.ts` would make this identity.
 */
export const AGENT_SECTION_KEY_INSTALLED: string = AGENT_SECTION_KEY.replaceAll(".", "-");

/** The factory `src/contracts/agent.ts` names `AgentExtensionFactory` (S1 installs its result). */
export const createAgentExtension: AgentExtensionFactory = (deps: AgentDeps): AgentExtension =>
  defineExtension({
    name: AGENT_EXTENSION_NAME,
    tools: resolveAgentTools(deps),
    sections: [
      // `tag: false`: this is the whole system prompt, not a fragment of one, so it is not
      // wrapped in `<hmwrk-role-and-date>…</hmwrk-role-and-date>`. `wrapSection()` still finds it
      // by key, which is what M2 decorators need.
      section(AGENT_SECTION_KEY_INSTALLED, (input) => renderSection(deps, input.conversationId), { tag: false }),
    ],
  });

/**
 * Render the section for one conversation: resolve the role, take the household clock, hand both
 * to {@link renderAgentPrompt}.
 *
 * Errors of `actors.get` are swallowed on purpose. A throwing section is reported as
 * `extension_error` and **omitted** (K1/README §System Prompt), i.e. the model would run with no
 * system prompt at all. A least-privilege prompt is the better failure: the section never fails.
 */
async function renderSection(deps: AgentDeps, conversationId: ConversationId): Promise<string> {
  const now = (deps.now ?? defaultNow)();
  const actor = await lookupActor(deps, conversationId);
  const ctx: AgentPromptContext = {
    userId: actor?.userId ?? "",
    role: actor?.role ?? FALLBACK_ROLE,
    today: formatIsoDate(now),
    now,
  };
  return renderAgentPrompt(ctx, resolveCapabilities(deps));
}

async function lookupActor(deps: AgentDeps, conversationId: ConversationId): Promise<ActorRecord | null> {
  try {
    return await deps.actors.get(conversationId);
  } catch {
    return null;
  }
}

/** SPEC §6: the prompt always has a date, even when the caller injects no clock. */
function defaultNow(): Date {
  return new Date();
}
