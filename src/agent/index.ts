/**
 * hmwrk agent barrel (A1).
 *
 * - {@link createAgentExtension} — the `hmwrk` extension (prompt section + M2 tool slot);
 * - {@link renderAgentPrompt} — the RU system prompt itself (pure, testable);
 * - {@link buildAgentRegistry} / {@link buildAgentExtensions} — the assembly point S1 uses.
 *
 * Ownership: `src/agent/**` is A1's in M1; M2 (`I2`) adds `src/agent/tools/**` behind the same
 * seam (`AgentDeps.tools` + `AgentToolset` from `src/contracts/agent.ts`).
 */

export * from "./extension.js";
export * from "./prompt.js";
export * from "./registry.js";
