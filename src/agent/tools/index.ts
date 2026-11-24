/**
 * The nine SPEC §5.5 tools, assembled into the slot A1's extension installs.
 *
 * ```ts
 * const tools = createHmwrkTools({ repos, spawnVerify, now }, core.actors);
 * const deps: AgentDeps = { actors: core.actors, models, now, repos, tools };
 * ```
 *
 * Two dependencies, deliberately separate:
 *
 * - {@link ToolDeps} (from `src/contracts/tasks.ts`) is the domain side: repositories, the verify
 *   spawner seam, the clock. It carries **no role** — one toolset serves both conversations.
 * - `actors` is K3's conversation → person directory. It is passed to the factory instead of read
 *   from the arguments because tool arguments come from the model: the role must not be something
 *   a prompt can claim. Each call resolves `api.conversationId` → `{ userId, role }`, and an
 *   unknown conversation is refused (see `tool.ts`).
 *
 * The object below is written in `TOOL_NAMES` order — the same order A1's prompt advertises and
 * the one tests assert, so the toolset and the prompt cannot silently drift apart.
 */

import type { ActorDirectory, AgentToolset } from "../../contracts/index.js";
import type { ToolDeps } from "../../contracts/tasks.js";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { TOOL_NAMES } from "../../domain/types.js";
import type { ToolName } from "../../domain/types.js";
import { listAssignmentsTool } from "./listAssignments.js";
import { parseScreenshotTool } from "./parseScreenshot.js";
import { manualAddAssignmentTool } from "./manualAddAssignment.js";
import { submitCheckInTool } from "./submitCheckIn.js";
import { getVerdictsTool } from "./getVerdicts.js";
import { approveVerificationTool } from "./approveVerification.js";
import { dismissVerificationTool } from "./dismissVerification.js";
import { getSettingsTool } from "./getSettings.js";
import { setSettingTool } from "./setSetting.js";
import { createToolRegistration } from "./tool.js";
import type { ToolEnvironment } from "./tool.js";

/**
 * SPEC §5.5 tools for one household.
 *
 * `deps.now` is called once per tool call, so «просрочено» and `decided_at` agree within one
 * answer. Passing `deps.repos` and `deps.spawnVerify` straight through keeps the tools free of
 * durable-task knowledge: they only know that `startVerify({ checkInId })` exists.
 */
export function createHmwrkTools(deps: ToolDeps, actors: ActorDirectory): AgentToolset {
  const env: ToolEnvironment = {
    repos: deps.repos,
    spawnVerify: deps.spawnVerify,
    now: deps.now,
    actors,
  };

  // `Record<ToolName, …>` rather than `Partial<…>`: the compiler then refuses a toolset that lost
  // one of the nine (the return type stays `AgentToolset`, A1's deliberately partial slot).
  const tools: Record<ToolName, ToolRegistration> = {
    list_assignments: createToolRegistration(listAssignmentsTool, env),
    parse_screenshot: createToolRegistration(parseScreenshotTool, env),
    manual_add_assignment: createToolRegistration(manualAddAssignmentTool, env),
    submit_check_in: createToolRegistration(submitCheckInTool, env),
    get_verdicts: createToolRegistration(getVerdictsTool, env),
    approve_verification: createToolRegistration(approveVerificationTool, env),
    dismiss_verification: createToolRegistration(dismissVerificationTool, env),
    get_settings: createToolRegistration(getSettingsTool, env),
    set_setting: createToolRegistration(setSettingTool, env),
  };

  return tools;
}
