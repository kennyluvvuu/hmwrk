# hmwrk orchestrator playbook

How the orchestrator runs this repo: product code and research go to BB subagents; the orchestrator owns only framing, briefs, merges, and the decision journal. Distilled from the M1–M3 buildout (20 subagent tasks across 9 waves). The full log and every decision live in [2026-11-24_m1-m3-parallel-buildout.md](2026-11-24_m1-m3-parallel-buildout.md) (RU): its §7–8 journal is the record; product truth is [docs/SPEC.md](../docs/SPEC.md) + [docs/adr/](../docs/adr/).

BB mechanics live in the guide chapters, not here — `bb guide threads` (spawn/handoff), `thread-inspection` (wait/inspect/output), `thread-messaging` (tell/steer/interactions), `thread-lifecycle` (retry), `environments` (worktrees). This playbook carries only what those chapters cannot: this project's own protocol.

## Role contract

**Hands on**: task framing, briefs, spawns, approvals, steers, merges, gate checks, journal and plan edits (each as its own commit — history is a deliverable), CLI glue for one-off commands.
**Hands off**: product code, tests, dependencies, docs under `docs/` except the journal/plan. Those ship only from a subagent branch through the gate. A failing merge goes back to its subagent with the error; the orchestrator patches nothing.

## Vocabulary

- **Wave** — one parallel batch of file-disjoint tasks; waves run in sequence. Contracts precede implementation: types shared by a wave are written in an earlier wave, so parallel tasks compile against one truth.
- **Brief** — the single-task prompt for one subagent ($TMPDIR/briefs/, never committed). Structure below.
- **Gate** — the merge ritual a finished task passes before it reaches `main`.
- **Journal** — §7+ of the plan doc: the append-only record of wave verdicts and accepted defaults.

## launching subagents

```bash
bb thread spawn \
  --project proj_wzbvp2akm3 \
  --prompt-file "$TMPDIR/briefs/<task>-brief.md" \
  --provider pi --model mistral/deepseek-v4-1-flash-1017 --reasoning-level high \
  --new-environment worktree --base-branch refs/heads/main \
  --permission-mode full --parent-self --parent-notifications auto \
  --title "<ID> · <name>" --json
```

Two pins are project policy, the rest are stock flags: `--permission-mode full` (the `pi` provider rejects other modes), and `refs/heads/main` because this repo has no origin. Worktrees branch `bb/*-<thread>` off `main`.

## Brief anatomy

Each brief carries, in this order:

1. **Context pointers** — exact paths the agent must read first: its plan card, SPEC sections, the pi-api-notes answers (K-numbers) it relies on.
2. **Seam quotes** — when a wave has parallel tasks sharing an interface, the brief quotes the interface verbatim, identically on both sides. The add/add conflict on the shared file is then trivial to resolve at merge (this shipped `contracts/tasks.ts` and `contracts/notify.ts`).
3. **Goal → numbered steps**, with the sandbox-memo block inlined.
4. **File ownership** — files the task may write; everything else named off-limits.
5. **Self-check** — green `npm ci && npm run typecheck && npm test`, clean `git status`, and a ready commit message (Conventional Commits, task ID in the subject).
6. **Report format** — branch, decisions, risks, handoffs to the next wave. "Short, no filler."

Write briefs in Russian and proofread before spawn: generated mixed-script artifacts reached several briefs during the buildout. The sandbox memo and command set already live in [AGENTS.md](../AGENTS.md) — briefs re-inline that block verbatim, they add nothing to it.

## Run cycle

1. **Frame** — read the journal, then split the user's goal into waves of file-disjoint tasks; write every brief of the wave before spawning any. Done when each brief passes proof-reading and file ownership is disjoint within the wave.
2. **Launch** — spawn each task per the command above. Capture every thread id.
3. **Tend** — wait through background shells (`bb guide thread-inspection`); answer `needs help` notices by resolving the pending interaction (`bb thread interactions`), then steer the agent with the workaround when a gate pattern repeats. A `tell` restarts a thread's turn — re-arm the wait afterwards. On a provider failure the thread errors and BB queues a retry itself; verify with `bb thread retry` (HTTP 409 means one is already queued). When the final agent message looks like a stray notification ("npm ci finished"), read `bb thread output` and `bb thread log` for the real report.
4. **Gate each task as it finishes** — merge its branch into `main`; resolve an add/add contract conflict to the union of both docs and interfaces; then on merged `main`: `export npm_config_cache="$TMPDIR/npm-cache" && npm ci && npm run typecheck && npm test`. E2e: `scripts/verify-m1.sh` after wiring waves; the long `verify-m2.sh`/`verify-m3.sh` after milestone waves. Green gate = merge stands; red gate goes back to the subagent.
5. **Close the wave** — append one journal line per wave (what held, what defaults were accepted, what was deferred) and commit it (`docs(plan): record <wave> verdicts`). Escalate to the owner only what breaks SPEC/ADRs, spends money, or touches credentials; record everything else in the journal yourself.

## Project gotchas (spawned agents will hit these)

The `pi` sandbox prompts on paths it reads as outside the project even in `--permission-mode full`. Known false positives, all legitimate work:

| Trigger | The agent was doing |
|---|---|
| `cd node_modules/… && grep … ../file.d.ts` | reading a sibling `.d.ts` under its own worktree |
| scratch files under `/tmp/…` | should have `$TMPDIR` |
| paths under `~/.bb/plugins/environment-git-worktree/…` | touching worktree host-data |

Resolution: `bb thread interactions list <thread> --json` → `respond <interactionId> <thread> --value '{"requestId":"<payload.data.requestId>","value":"Allow for session"}'`. A session allowance covers one narrow pattern — the next variant prompts again; after two of the same kind, steer the agent with the recipe instead (paths from worktree root, no `../../`, scratch only in `$TMPDIR`).
