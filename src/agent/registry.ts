/**
 * Registry assembly — the single place S1 gets extensions from.
 *
 * K1/K7: `createRegistry()` returns the host-owned registry; `install()` publishes at once and
 * replaces an installed extension by name. `Harness.open` then takes the registry as
 * `HarnessOptions.registry` (`Registry` is a `RegistryReader`), and every conversation selects
 * every installed extension by default.
 *
 * Two callers, two shapes, one source of truth:
 * - S1 opens the Harness: it wants `OpenHarnessOptions.extensions` (an `Extension[]`), so it
 *   calls {@link buildAgentExtensions};
 * - tests and anything holding a registry directly call {@link buildAgentRegistry}.
 *
 * M1 installs exactly one extension (`hmwrk`, no tools). M2's nine tools arrive through
 * `deps.tools` and stay inside that same extension (see `resolveAgentTools` in
 * `./extension.ts`), so this module does not change: `extraExtensions` is only for extensions
 * that are genuinely separate (a future imaging/wrap extension, a hook bundle), and they install
 * **before** `hmwrk` so its role/date section renders after their sections.
 */

import { createRegistry } from "@earendil-works/pi-durable";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import { AGENT_EXTENSION_NAME, type AgentDeps } from "../contracts/index.js";
import { createAgentExtension } from "./extension.js";

/** What {@link buildAgentRegistry} and {@link buildAgentExtensions} need. */
export interface AgentRegistryConfig {
  /** The dependency bundle of the `hmwrk` extension (role source, clock, M2 tool slot). */
  readonly deps: AgentDeps;
  /**
   * Extensions installed besides `hmwrk`, in order. Empty in M1 — the nine SPEC §5.5 tools are
   * part of `hmwrk` itself, not separate extensions.
   */
  readonly extensions?: readonly Extension[];
}

/**
 * The extensions to hand `Harness.open({ extensions })`, in install order.
 *
 * S1 keeps this list and re-installs it into a fresh registry on restart; nothing in the
 * registry is stored (conversations store extension **names**), so rebuilding it per boot is the
 * intended flow.
 */
export function buildAgentExtensions(cfg: AgentRegistryConfig): readonly Extension[] {
  return [...(cfg.extensions ?? []), createAgentExtension(cfg.deps)];
}

/**
 * A registry with M2's extensions (if any) and `hmwrk` installed.
 *
 * Tests use it directly; S1 normally passes {@link buildAgentExtensions} to `openHarness`, which
 * builds the registry itself.
 */
export function buildAgentRegistry(cfg: AgentRegistryConfig): Registry {
  const registry = createRegistry();
  for (const extension of buildAgentExtensions(cfg)) registry.install(extension);
  return registry;
}

/** Convenience for logs and assertions: is the agent's own extension installed? */
export function isAgentInstalled(registry: Registry): boolean {
  return registry.snapshot().extension(AGENT_EXTENSION_NAME) !== undefined;
}
