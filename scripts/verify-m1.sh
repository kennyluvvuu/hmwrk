#!/usr/bin/env bash
#
# M1 end-to-end verification (plan V1, milestone-1 merge gate).
#
# Boots the real core (`node --import tsx src/index.ts`) over a throwaway
# DATA_DIR in $TMPDIR with fake role keys, then checks SPEC §3/§6 behaviour
# against the running process:
#
#   1. `GET /healthz` → 200
#   2. `GET /v1/models` → exactly one model, `hmwrk`
#   3. `POST /v1/chat/completions` (stream=false, parent key) → OpenAI JSON echo
#   4. `POST /v1/chat/completions` (stream=true, child key) → SSE sequence:
#      role delta → content deltas → finish_reason chunk → `data: [DONE]`
#   5. no key → 401; unknown key → 401
#   6. SIGTERM → restart on the same DATA_DIR → the same parent asks again:
#      the conversation id from the logs is unchanged, and SQLite still holds
#      exactly two conversations (one per role key)
#   7. no error-level log records and no warnings beyond the expected 401s
#
# Usage (from the repo root or anywhere):
#
#   bash scripts/verify-m1.sh
#
# Exits 0 only when every check passed. On failure the scratch directory (logs,
# response bodies, SQLite file) is printed and kept for inspection; set
# KEEP_ARTIFACTS=1 to keep it on success too.
#
# Requirements: node >= 22 with devDependencies installed (`npm ci`), curl.
# `sqlite3` is optional: without it the persistence check falls back to the
# conversation ids in the logs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Fake credentials: names and shapes are what src/config/env.ts validates, the
# values are deliberately obvious test strings and never leave this process.
PARENT_KEY="hmwrk-m1-parent-test-key"
CHILD_KEY="hmwrk-m1-child-test-key"

PARENT_TEXT="привет, это родитель: проверка echo"
CHILD_TEXT="привет, это ребёнок: проверка SSE-стрима"

PASS_COUNT=0
FAIL_COUNT=0
SERVER_PID=""
SCRATCH=""
KEEP_ARTIFACTS="${KEEP_ARTIFACTS:-0}"

PASS_MARK="ok  "
FAIL_MARK="FAIL"

say() { printf '%s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }
ok() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  %s %s\n' "$PASS_MARK" "$*"
}
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '  %s %s\n' "$FAIL_MARK" "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    say "verify-m1: required command not found: $1" >&2
    exit 2
  fi
}

require_command node
require_command curl

if [ ! -d node_modules ]; then
  say "verify-m1: node_modules is missing; run 'npm ci' in $REPO_ROOT first" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Scratch space, data directory, port
# ---------------------------------------------------------------------------

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/hmwrk-m1.XXXXXX")"
DATA_DIR="$SCRATCH/data"
LOG_1="$SCRATCH/server-1.log"
LOG_2="$SCRATCH/server-2.log"
mkdir -p "$DATA_DIR"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$FAIL_COUNT" -ne 0 ] || [ "$KEEP_ARTIFACTS" = "1" ]; then
    say "verify-m1: artifacts kept in $SCRATCH"
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

# A free loopback port: bind :0, read the port the OS picked, close again.
pick_port() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => process.stdout.write(String(port)));
    });
  '
}
PORT="$(pick_port)" || {
  say "verify-m1: could not find a free port" >&2
  exit 2
}

# K8 model slots that R1 verified against the 1.6.0 catalogue, so boot logs no
# "model slots are not in the pi-ai catalogue" warning. M1 echoes and never
# calls a provider; the ids only need to be the ones models.json will carry.
cat >"$DATA_DIR/models.json" <<'JSON'
{
  "read": { "provider": "groq", "modelId": "qwen/qwen3.6-27b" },
  "verify": { "provider": "mistral", "modelId": "deepseek-v4-1-flash-1017" },
  "chat": { "provider": "mistral", "modelId": "deepseek-v4-1-flash-1017" }
}
JSON

cat >"$SCRATCH/parent-chat.json" <<JSON
{"model":"hmwrk","messages":[{"role":"user","content":"$PARENT_TEXT"}]}
JSON

cat >"$SCRATCH/child-chat.json" <<JSON
{"model":"hmwrk","stream":true,"messages":[{"role":"user","content":"$CHILD_TEXT"}]}
JSON

say "verify-m1: repo=$REPO_ROOT"
say "verify-m1: scratch=$SCRATCH"
say "verify-m1: port=$PORT"

# ---------------------------------------------------------------------------
# Boot helpers
# ---------------------------------------------------------------------------

start_core() { # $1 = log file
  PORT="$PORT" \
    DATA_DIR="$DATA_DIR" \
    LOG_LEVEL=debug \
    HMWRK_PARENT_KEY="$PARENT_KEY" \
    HMWRK_CHILD_KEY="$CHILD_KEY" \
    node --import tsx src/index.ts >"$1" 2>&1 &
  SERVER_PID=$!
}

# Waits for /healthz, but gives up quickly if the process died on boot.
wait_for_health() {
  local url="http://127.0.0.1:${PORT}/healthz"
  local attempt
  for attempt in $(seq 1 100); do
    if curl -fsS -m 1 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.2
  done
  return 1
}

stop_core() { # $1 = human label for the assertion
  local label="$1"
  local rc=0
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" || rc=$?
  SERVER_PID=""
  if [ "$rc" -eq 0 ]; then
    ok "SIGTERM → graceful exit 0 ($label)"
  else
    fail "SIGTERM → exit $rc instead of 0 ($label)"
  fi
}

# curl errors are reported by curl itself on stderr and turn into a failed check with an
# empty HTTP code, instead of aborting the run before the summary (set -e).
api() { curl -sS -m 15 "$@" || true; }

# Runs a node assertion: `node_assert <label> <module source> [args…]`.
# The source must exit non-zero (and print a reason) when the check fails;
# process.argv[1] is the first extra argument.
node_assert() {
  local label="$1"
  local source="$2"
  shift 2
  if node --input-type=module -e "$source" "$@"; then
    ok "$label"
  else
    fail "$label"
  fi
}

# `pi_conversations` rows in the shared SQLite file (K2). Prints "unavailable"
# when neither sqlite3 nor node:sqlite can read it, so the caller can decide.
count_conversations() {
  local db="$DATA_DIR/hmwrk.sqlite"
  if [ ! -f "$db" ]; then
    printf 'unavailable\n'
    return 0
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" "select count(*) from pi_conversations;" && return 0
  fi
  local source='
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const row = db.prepare("select count(*) as n from pi_conversations").get();
    process.stdout.write(String(row.n));
  '
  if node --input-type=module -e "$source" "$db" 2>/dev/null; then
    return 0
  fi
  if node --experimental-sqlite --input-type=module -e "$source" "$db" 2>/dev/null; then
    return 0
  fi
  printf 'unavailable\n'
}

# Conversation id of `userId` in one server log (debug "chat completion" records).
conv_id_for() { # $1 = log file, $2 = userId
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [file, userId] = process.argv.slice(1);
    const hit = readFileSync(file, "utf8")
      .split("\n")
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((rec) => rec !== null && rec.msg === "chat completion" && rec.userId === userId);
    if (!hit) { console.error(`no chat completion record for ${userId} in ${file}`); process.exit(1); }
    process.stdout.write(String(hit.conversationId));
  ' "$1" "$2"
}

# ---------------------------------------------------------------------------
# Phase 1: boot, health, models, 401
# ---------------------------------------------------------------------------

section "boot (DATA_DIR=$DATA_DIR)"

start_core "$LOG_1"
if wait_for_health; then
  ok "core booted and /healthz is 200"
else
  fail "core did not become healthy"
  say "--- $LOG_1 ---"
  cat "$LOG_1" || true
  say "--- done ---"
  exit 1
fi

api -o "$SCRATCH/healthz.json" "http://127.0.0.1:${PORT}/healthz"
node_assert "/healthz body is {status:ok}" '
  import { readFileSync } from "node:fs";
  const body = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (body.status !== "ok") { console.error("unexpected body:", JSON.stringify(body)); process.exit(1); }
' "$SCRATCH/healthz.json"

section "GET /v1/models"

HTTP_CODE="$(api -o "$SCRATCH/models.json" -w '%{http_code}' \
  -H "Authorization: Bearer $PARENT_KEY" \
  "http://127.0.0.1:${PORT}/v1/models")"
if [ "$HTTP_CODE" = "200" ]; then
  ok "GET /v1/models → 200 with the parent key"
else
  fail "GET /v1/models → $HTTP_CODE (expected 200)"
fi

node_assert "/v1/models lists exactly one model, hmwrk" '
  import { readFileSync } from "node:fs";
  const body = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const data = body.data;
  if (body.object !== "list" || !Array.isArray(data) || data.length !== 1) {
    console.error("unexpected model list:", JSON.stringify(body));
    process.exit(1);
  }
  const [model] = data;
  if (model.id !== "hmwrk" || model.object !== "model" || model.owned_by !== "hmwrk") {
    console.error("unexpected model entry:", JSON.stringify(model));
    process.exit(1);
  }
' "$SCRATCH/models.json"

section "auth"

HTTP_CODE="$(api -o "$SCRATCH/no-key.json" -w '%{http_code}' \
  "http://127.0.0.1:${PORT}/v1/models")"
if [ "$HTTP_CODE" = "401" ]; then
  ok "no Authorization header → 401"
else
  fail "no Authorization header → $HTTP_CODE (expected 401)"
fi

node_assert "401 body is an OpenAI-shaped error" '
  import { readFileSync } from "node:fs";
  const body = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const error = body.error;
  if (!error || error.type !== "invalid_request_error" || error.code !== "missing_credentials" || typeof error.message !== "string") {
    console.error("unexpected error body:", JSON.stringify(body));
    process.exit(1);
  }
' "$SCRATCH/no-key.json"

HTTP_CODE="$(api -o "$SCRATCH/bad-key.json" -w '%{http_code}' \
  -H "Authorization: Bearer not-a-configured-key" \
  "http://127.0.0.1:${PORT}/v1/models")"
if [ "$HTTP_CODE" = "401" ]; then
  ok "unknown API key → 401"
else
  fail "unknown API key → $HTTP_CODE (expected 401)"
fi

# ---------------------------------------------------------------------------
# Phase 2: non-streaming echo (parent)
# ---------------------------------------------------------------------------

section "POST /v1/chat/completions (stream=false, parent)"

HTTP_CODE="$(api -o "$SCRATCH/chat-parent.json" -w '%{http_code}' \
  -H "Authorization: Bearer $PARENT_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary "@$SCRATCH/parent-chat.json" \
  "http://127.0.0.1:${PORT}/v1/chat/completions")"
if [ "$HTTP_CODE" = "200" ]; then
  ok "stream=false → 200"
else
  fail "stream=false → $HTTP_CODE (expected 200)"
fi

node_assert "stream=false body is a valid chat.completion that echoes the prompt" '
  import { readFileSync } from "node:fs";
  const [file, expected] = process.argv.slice(1);
  const body = JSON.parse(readFileSync(file, "utf8"));
  const choice = body.choices?.[0];
  const problems = [];
  if (body.object !== "chat.completion") problems.push(`object=${body.object}`);
  if (body.model !== "hmwrk") problems.push(`model=${body.model}`);
  if (typeof body.id !== "string" || !body.id.startsWith("chatcmpl-")) problems.push(`id=${body.id}`);
  if (typeof body.created !== "number") problems.push("created is not a number");
  if (choice?.index !== 0) problems.push("choices[0].index is not 0");
  if (choice?.message?.role !== "assistant") problems.push("message.role is not assistant");
  if (choice?.message?.content !== expected) problems.push(`content=${JSON.stringify(choice?.message?.content)}`);
  if (choice?.finish_reason !== "stop") problems.push(`finish_reason=${choice?.finish_reason}`);
  if (typeof body.usage?.total_tokens !== "number") problems.push("usage.total_tokens is missing");
  if (problems.length > 0) { console.error("bad completion:", problems.join("; ")); process.exit(1); }
' "$SCRATCH/chat-parent.json" "$PARENT_TEXT"

# ---------------------------------------------------------------------------
# Phase 3: SSE streaming (child)
# ---------------------------------------------------------------------------

section "POST /v1/chat/completions (stream=true, child)"

HTTP_CODE="$(api -N -o "$SCRATCH/chat-child.sse" -D "$SCRATCH/chat-child.headers" -w '%{http_code}' \
  -H "Authorization: Bearer $CHILD_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary "@$SCRATCH/child-chat.json" \
  "http://127.0.0.1:${PORT}/v1/chat/completions")"
if [ "$HTTP_CODE" = "200" ]; then
  ok "stream=true → 200"
else
  fail "stream=true → $HTTP_CODE (expected 200)"
fi

if grep -qi '^content-type: text/event-stream' "$SCRATCH/chat-child.headers"; then
  ok "stream=true → content-type: text/event-stream"
else
  fail "stream=true → wrong or missing content-type"
fi

node_assert "SSE frames: role delta, content deltas, finish_reason chunk, [DONE]" '
  import { readFileSync } from "node:fs";
  const [file, expected] = process.argv.slice(1);
  const raw = readFileSync(file, "utf8");
  const problems = [];
  if (!raw.endsWith("data: [DONE]\n\n")) problems.push("stream does not end with data: [DONE]");

  const lines = raw.split("\n").filter((line) => line !== "");
  const stray = lines.filter((line) => !line.startsWith("data: "));
  if (stray.length > 0) problems.push(`stray SSE lines: ${JSON.stringify(stray.slice(0, 3))}`);

  const dataLines = lines.filter((line) => line.startsWith("data: "));
  if (dataLines.at(-1) !== "data: [DONE]") problems.push("last data line is not [DONE]");

  const payloads = [];
  for (const line of dataLines.slice(0, -1)) {
    try { payloads.push(JSON.parse(line.slice("data: ".length))); }
    catch { problems.push(`unparseable chunk: ${line.slice(0, 80)}`); }
  }
  if (payloads.length < 3) problems.push(`expected at least 3 chunks, got ${payloads.length}`);

  const [first] = payloads;
  if (first?.object !== "chat.completion.chunk") problems.push(`object=${first?.object}`);
  if (first?.choices?.[0]?.delta?.role !== "assistant") problems.push("first chunk is not a role delta");
  if (first?.choices?.[0]?.finish_reason !== null) problems.push("first chunk carries finish_reason");
  if (first?.choices?.[0]?.delta?.content !== undefined) problems.push("first chunk carries content");

  const last = payloads.at(-1);
  if (last?.choices?.[0]?.finish_reason !== "stop") problems.push(`last chunk finish_reason=${last?.choices?.[0]?.finish_reason}`);
  if (last?.choices?.[0]?.delta?.content !== undefined) problems.push("finish chunk carries content");

  const text = payloads
    .slice(1, -1)
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
    .join("");
  if (text !== expected) problems.push(`reassembled text=${JSON.stringify(text)}`);

  const ids = new Set(payloads.map((chunk) => chunk.id));
  if (ids.size !== 1) problems.push(`chunk ids differ: ${[...ids].join(", ")}`);

  for (const chunk of payloads) {
    if (chunk.error !== undefined) problems.push(`error chunk: ${JSON.stringify(chunk.error)}`);
    if (chunk.model !== "hmwrk") problems.push(`chunk model=${chunk.model}`);
  }

  if (problems.length > 0) { console.error("bad SSE stream:", problems.join("; ")); process.exit(1); }
' "$SCRATCH/chat-child.sse" "$CHILD_TEXT"

# ---------------------------------------------------------------------------
# Phase 4: roles map to distinct conversations before the restart
# ---------------------------------------------------------------------------

section "conversations before restart"

PARENT_CONV_BEFORE="$(conv_id_for "$LOG_1" "key:parent" || true)"
CHILD_CONV="$(conv_id_for "$LOG_1" "key:child" || true)"

if [ -n "$PARENT_CONV_BEFORE" ]; then
  ok "parent request logged conversation id $PARENT_CONV_BEFORE"
else
  fail "parent request left no conversation id in the log"
fi
if [ -n "$CHILD_CONV" ] && [ "$CHILD_CONV" != "$PARENT_CONV_BEFORE" ]; then
  ok "child request logged a different conversation id $CHILD_CONV"
else
  fail "parent and child did not get distinct conversations (parent=$PARENT_CONV_BEFORE child=$CHILD_CONV)"
fi

stop_core "before restart"

CONVERSATIONS_BEFORE="$(count_conversations)"
if [ "$CONVERSATIONS_BEFORE" = "2" ]; then
  ok "SQLite holds exactly 2 conversations after two role keys"
elif [ "$CONVERSATIONS_BEFORE" = "unavailable" ]; then
  say "  skip SQLite conversation count (neither sqlite3 nor node:sqlite available)"
else
  fail "SQLite holds $CONVERSATIONS_BEFORE conversations (expected 2)"
fi

if grep -q '"msg":"hmwrk stopped"' "$LOG_1"; then
  ok "shutdown log confirms the core closed after SIGTERM"
else
  fail "no 'hmwrk stopped' record after SIGTERM"
fi

# ---------------------------------------------------------------------------
# Phase 5: STOP test — restart on the same data, same person, same conversation
# ---------------------------------------------------------------------------

section "restart on the same DATA_DIR"

start_core "$LOG_2"
if wait_for_health; then
  ok "core booted again over the existing SQLite file"
else
  fail "restarted core did not become healthy"
  say "--- $LOG_2 ---"
  cat "$LOG_2" || true
  say "--- done ---"
  exit 1
fi

HTTP_CODE="$(api -o "$SCRATCH/chat-parent-after.json" -w '%{http_code}' \
  -H "Authorization: Bearer $PARENT_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary "@$SCRATCH/parent-chat.json" \
  "http://127.0.0.1:${PORT}/v1/chat/completions")"
if [ "$HTTP_CODE" = "200" ]; then
  ok "the same parent gets 200 after the restart"
else
  fail "the same parent got $HTTP_CODE after the restart (expected 200)"
fi

node_assert "the post-restart answer still echoes the prompt" '
  import { readFileSync } from "node:fs";
  const [file, expected] = process.argv.slice(1);
  const body = JSON.parse(readFileSync(file, "utf8"));
  if (body.choices?.[0]?.message?.content !== expected) {
    console.error("content:", JSON.stringify(body.choices?.[0]?.message?.content));
    process.exit(1);
  }
' "$SCRATCH/chat-parent-after.json" "$PARENT_TEXT"

PARENT_CONV_AFTER="$(conv_id_for "$LOG_2" "key:parent" || true)"
if [ -n "$PARENT_CONV_AFTER" ] && [ "$PARENT_CONV_AFTER" = "$PARENT_CONV_BEFORE" ]; then
  ok "the parent resumed conversation $PARENT_CONV_AFTER (persisted across restart)"
else
  fail "conversation id changed across restart (before=$PARENT_CONV_BEFORE after=$PARENT_CONV_AFTER)"
fi

stop_core "after restart"

CONVERSATIONS_AFTER="$(count_conversations)"
if [ "$CONVERSATIONS_AFTER" = "unavailable" ]; then
  say "  skip SQLite conversation count after restart (reader unavailable)"
elif [ "$CONVERSATIONS_AFTER" = "$CONVERSATIONS_BEFORE" ]; then
  ok "SQLite still holds $CONVERSATIONS_AFTER conversations (no duplicate for a known user)"
else
  fail "SQLite holds $CONVERSATIONS_AFTER conversations (expected $CONVERSATIONS_BEFORE)"
fi

# ---------------------------------------------------------------------------
# Phase 6: log hygiene
# ---------------------------------------------------------------------------

section "logs"

if grep -q '"msg":"agent extension installed"' "$LOG_1"; then
  ok "the hmwrk agent extension was installed at boot"
else
  fail "boot log has no 'agent extension installed' record"
fi

if grep -q '"msg":"role resolver configured".*"mode":"static-keys"' "$LOG_1"; then
  ok "role resolver runs in static-keys mode without a users directory (M1)"
else
  fail "role resolver did not report static-keys mode"
fi

if grep -h '"level":"error"' "$LOG_1" "$LOG_2"; then
  fail "error-level records found in the server logs"
else
  ok "no error-level log records"
fi

UNEXPECTED_WARNINGS="$(grep -h '"level":"warn"' "$LOG_1" "$LOG_2" | grep -v '"msg":"request rejected"' || true)"
if [ -n "$UNEXPECTED_WARNINGS" ]; then
  fail "unexpected warnings in the server logs"
  printf '%s\n' "$UNEXPECTED_WARNINGS"
else
  ok "no warnings besides the expected authentication rejections"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

printf '\n'
if [ "$FAIL_COUNT" -ne 0 ]; then
  say "M1 verification FAILED: $FAIL_COUNT failed, $PASS_COUNT passed"
  exit 1
fi
say "M1 verification passed: $PASS_COUNT checks, 0 failed"
