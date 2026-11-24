#!/usr/bin/env bash
#
# M2 end-to-end verification (plan P2, milestone-2 merge gate).
#
# Boots the real core (`node --import tsx src/index.ts`) over a throwaway DATA_DIR
# in $TMPDIR with fake role keys and **pi-ai's faux provider** (`HMWRK_FAUX_LLM=1`,
# script: `scripts/fixtures/faux-m2.json`). No API keys, no network, real
# everything else: HTTP endpoint, auth, photo intake, agent loop, the nine tools,
# the durable verify task and SQLite.
#
# The cycle driven through `POST /v1/chat/completions`:
#
#   a) parent adds an assignment (agent → `manual_add_assignment`);
#   b) the next prompt carries the SPEC §6 active-assignments summary, and
#      `list_assignments` returns the new row (SSE);
#   c) the child reports with a 1×1 PNG attached to the message (photo store,
#      check-in, `in_review`) and the verify task produces a draft verdict;
#   d) the parent sees the draft; the child does not;
#   e) the parent approves it → assignment `done`; the child sees the verdict;
#   f) an assignment due in the past is listed as overdue and marked in the prompt;
#   g) a retried request (`X-Request-Id`) does not run a second model call and adds
#      no duplicate conversation entries; 401 checks still hold after the cycle.
#
# Usage (from the repo root or anywhere):
#
#   bash scripts/verify-m2.sh
#
# Exits 0 only when every check passed. On failure the scratch directory (logs,
# responses, SSE bodies, SQLite) is printed and kept; KEEP_ARTIFACTS=1 keeps it on
# success too.
#
# Requirements: Node >= 22 with devDependencies installed (`npm ci`), curl, jq.
# `sqlite3` is preferred; without it the script falls back to `node:sqlite`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PARENT_KEY="hmwrk-m2-parent-test-key"
CHILD_KEY="hmwrk-m2-child-test-key"

PARENT_ADD_TEXT="добавь задание математика №12–14 к завтра"
PARENT_LIST_TEXT="что задано?"
CHILD_REPORT_TEXT="сделал математику"
PARENT_VERDICTS_TEXT="что по проверкам?"
CHILD_VERDICTS_TEXT="что по математике?"
CHILD_VERDICTS_DRAFT_TEXT="проверили мою работу?"
PARENT_APPROVE_TEXT="утверди проверку"
PARENT_OVERDUE_ADD_TEXT="добавь задание: русский язык, упр. 3, вчера"
PARENT_OVERDUE_TEXT="что просрочено?"
RETRY_TEXT="что у нас в работе?"

# A minimal but signature-valid 1×1 PNG (the store checks magic bytes, not pixels).
PNG_BASE64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

PASS_COUNT=0
FAIL_COUNT=0
SERVER_PID=""
SCRATCH=""
DB=""
DB_MODE=""
NODE_SQLITE_FLAG=""
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
    say "verify-m2: required command not found: $1" >&2
    exit 2
  fi
}

require_command node
require_command curl
require_command jq

if [ ! -d node_modules ]; then
  say "verify-m2: node_modules is missing; run 'npm ci' in $REPO_ROOT first" >&2
  exit 2
fi

FIXTURE="$REPO_ROOT/scripts/fixtures/faux-m2.json"
if [ ! -f "$FIXTURE" ]; then
  say "verify-m2: faux fixture is missing: $FIXTURE" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Scratch space, data directory, port
# ---------------------------------------------------------------------------

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/hmwrk-m2.XXXXXX")"
DATA_DIR="$SCRATCH/data"
LOG="$SCRATCH/server.log"
mkdir -p "$DATA_DIR"
DB="$DATA_DIR/hmwrk.sqlite"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$FAIL_COUNT" -ne 0 ] || [ "$KEEP_ARTIFACTS" = "1" ]; then
    say "verify-m2: artifacts kept in $SCRATCH"
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
  say "verify-m2: could not find a free port" >&2
  exit 2
}

# K8 model slots from R1; the faux hook replaces them at boot, but config still
# validates models.json, and valid ids keep boot free of catalogue warnings.
cat >"$DATA_DIR/models.json" <<'JSON'
{
  "read": { "provider": "groq", "modelId": "qwen/qwen3.6-27b" },
  "verify": { "provider": "mistral", "modelId": "deepseek-v4-1-flash-1017" },
  "chat": { "provider": "mistral", "modelId": "deepseek-v4-1-flash-1017" }
}
JSON

say "verify-m2: repo=$REPO_ROOT"
say "verify-m2: scratch=$SCRATCH"
say "verify-m2: port=$PORT"
say "verify-m2: fixture=$FIXTURE"

# ---------------------------------------------------------------------------
# Boot helpers
# ---------------------------------------------------------------------------

start_core() {
  PORT="$PORT" \
    DATA_DIR="$DATA_DIR" \
    LOG_LEVEL=debug \
    HMWRK_PARENT_KEY="$PARENT_KEY" \
    HMWRK_CHILD_KEY="$CHILD_KEY" \
    HMWRK_FAUX_LLM=1 \
    HMWRK_FAUX_SCRIPT="$FIXTURE" \
    node --import tsx src/index.ts >"$LOG" 2>&1 &
  SERVER_PID=$!
}

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

# curl errors become a failed check with an empty HTTP code, not an aborted run.
api() { curl -sS -m 30 "$@" || true; }

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

expect_eq() { # label actual expected
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    fail "$1 (got '$2', expected '$3')"
  fi
}

expect_text_has() { # label text needle
  if printf '%s' "$2" | grep -qF -- "$3"; then
    ok "$1"
  else
    fail "$1 (missing: $3)"
  fi
}

expect_text_lacks() { # label text needle
  if printf '%s' "$2" | grep -qF -- "$3"; then
    fail "$1 (unexpected: $3)"
  else
    ok "$1"
  fi
}

expect_file_has() { # label file needle
  if grep -qF -- "$3" "$2"; then
    ok "$1"
  else
    fail "$1 (missing in $2: $3)"
  fi
}

answer_text() { # body file
  jq -r '.choices[0].message.content // ""' "$1"
}

expect_answer_has() { # label body file needle
  expect_text_has "$1" "$(answer_text "$2")" "$3"
}

expect_answer_lacks() { # label body file needle
  expect_text_lacks "$1" "$(answer_text "$2")" "$3"
}

# One POST /v1/chat/completions; prints the HTTP code and writes the body.
post_chat() { # key body-file out-file [curl args…]
  local key="$1"
  local body="$2"
  local out="$3"
  shift 3
  api -o "$out" -w '%{http_code}' \
    -H "Authorization: Bearer $key" \
    -H 'Content-Type: application/json' \
    --data-binary "@$body" \
    "$@" \
    "http://127.0.0.1:${PORT}/v1/chat/completions"
}

# A text message body for one user turn; `stream` is optional (default false).
write_text_body() { # out-file text [stream]
  jq -n \
    --arg content "$2" \
    --argjson stream "${3:-false}" \
    '{ model: "hmwrk", stream: $stream, messages: [{ role: "user", content: $content }] }' >"$1"
}

# ---------------------------------------------------------------------------
# SQLite access (sqlite3 preferred, node:sqlite fallback)
# ---------------------------------------------------------------------------

NODE_DB_VALUE='
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const row = db.prepare(process.argv[2]).get();
const value = row === undefined ? "" : Object.values(row)[0];
process.stdout.write(value === null || value === undefined ? "" : String(value));
'
NODE_DB_JSON='
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all()));
'

init_db_reader() {
  if command -v sqlite3 >/dev/null 2>&1; then
    DB_MODE=sqlite3
    return 0
  fi
  if node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    new DatabaseSync(process.argv[1], { readOnly: true }).close();
  ' "$DB" 2>/dev/null; then
    DB_MODE=node
    return 0
  fi
  if node --experimental-sqlite --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    new DatabaseSync(process.argv[1], { readOnly: true }).close();
  ' "$DB" 2>/dev/null; then
    DB_MODE=node
    NODE_SQLITE_FLAG="--experimental-sqlite"
    return 0
  fi
  say "verify-m2: neither sqlite3 nor node:sqlite can read $DB" >&2
  exit 2
}

db_value() {
  if [ "$DB_MODE" = "sqlite3" ]; then
    sqlite3 "$DB" "$1"
    return 0
  fi
  node ${NODE_SQLITE_FLAG:+"$NODE_SQLITE_FLAG"} --input-type=module -e "$NODE_DB_VALUE" "$DB" "$1"
}

db_json() {
  if [ "$DB_MODE" = "sqlite3" ]; then
    sqlite3 -json "$DB" "$1"
    return 0
  fi
  node ${NODE_SQLITE_FLAG:+"$NODE_SQLITE_FLAG"} --input-type=module -e "$NODE_DB_JSON" "$DB" "$1"
}

# Poll `db_value` until it equals the expected value (or the timeout expires).
wait_db_value() { # sql expected timeout-tenths
  local sql="$1"
  local expected="$2"
  local attempts="${3:-100}"
  local value=""
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    value="$(db_value "$sql")"
    if [ "$value" = "$expected" ]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# The system prompt as the model actually saw it: replay `pi.system` section patches.
prompt_sections() {
  db_json "SELECT record FROM pi_entries WHERE record LIKE '%hmwrk-role-and-date%'" |
    jq -r '
      [ .[] | .record | fromjson
        | select(.kind == "pi.system")
        | .model[0].sections["hmwrk-role-and-date"] // empty
      ] | join("\n")
    '
}

# ---------------------------------------------------------------------------
# Phase 1: boot, health, models, auth
# ---------------------------------------------------------------------------

section "boot (DATA_DIR=$DATA_DIR, faux models)"

start_core
if wait_for_health; then
  ok "core booted and /healthz is 200"
else
  fail "core did not become healthy"
  say "--- $LOG ---"
  cat "$LOG" || true
  say "--- done ---"
  exit 1
fi

init_db_reader

expect_file_has "boot log: domain schema migrated" "$LOG" '"msg":"domain schema ready"'
expect_file_has "boot log: the hmwrk extension is installed with all nine tools" "$LOG" '"tools":9'
expect_file_has "boot log: the endpoint answers with the agent" "$LOG" '"msg":"answering with the agent"'
expect_file_has "boot log: the faux hook is loud about replacing the models" "$LOG" 'HMWRK_FAUX_LLM is on'

HTTP_CODE="$(api -o "$SCRATCH/healthz.json" -w '%{http_code}' "http://127.0.0.1:${PORT}/healthz")"
expect_eq "GET /healthz → 200" "$HTTP_CODE" "200"

HTTP_CODE="$(api -o "$SCRATCH/models.json" -w '%{http_code}' \
  -H "Authorization: Bearer $PARENT_KEY" \
  "http://127.0.0.1:${PORT}/v1/models")"
expect_eq "GET /v1/models → 200" "$HTTP_CODE" "200"
if jq -e '[.data[] | select(.id == "hmwrk")] | length == 1' "$SCRATCH/models.json" >/dev/null; then
  ok "GET /v1/models lists the single hmwrk model"
else
  fail "GET /v1/models does not list hmwrk"
fi

HTTP_CODE="$(api -o "$SCRATCH/no-key.json" -w '%{http_code}' "http://127.0.0.1:${PORT}/v1/models")"
expect_eq "no Authorization header → 401" "$HTTP_CODE" "401"
if jq -e '.error.code == "missing_credentials" and .error.type == "invalid_request_error"' \
  "$SCRATCH/no-key.json" >/dev/null; then
  ok "401 body is an OpenAI-shaped error"
else
  fail "401 body is not OpenAI-shaped"
fi

HTTP_CODE="$(api -o "$SCRATCH/bad-key.json" -w '%{http_code}' \
  -H "Authorization: Bearer not-a-configured-key" \
  "http://127.0.0.1:${PORT}/v1/models")"
expect_eq "unknown API key → 401" "$HTTP_CODE" "401"

# ---------------------------------------------------------------------------
# a) Parent adds an assignment through the agent
# ---------------------------------------------------------------------------

section "a) parent adds an assignment"

write_text_body "$SCRATCH/add-math.json" "$PARENT_ADD_TEXT"
HTTP_CODE="$(post_chat "$PARENT_KEY" "$SCRATCH/add-math.json" "$SCRATCH/add-math.response.json")"
expect_eq "parent add → 200" "$HTTP_CODE" "200"
expect_answer_has "the agent confirms the assignment" "$SCRATCH/add-math.response.json" "Добавил задание: «Математика»"
expect_answer_has "the confirmation lists all items" "$SCRATCH/add-math.response.json" "№ 12, № 13, № 14"
expect_answer_has "the confirmation names the initial status" "$SCRATCH/add-math.response.json" "ждёт отчёта"

expect_eq "assignments table has one row" "$(db_value 'SELECT count(*) FROM assignments')" "1"
ASSIGNMENT_ID="$(db_value "SELECT id FROM assignments WHERE subject = 'Математика'")"
if [ -n "$ASSIGNMENT_ID" ]; then
  ok "assignment id was generated ($ASSIGNMENT_ID)"
else
  fail "assignment id is empty"
fi
expect_eq "the assignment is active and manual" \
  "$(db_value "SELECT status || '/' || source FROM assignments WHERE id = '$ASSIGNMENT_ID'")" \
  "active/manual"
expect_eq "three items were stored in order" \
  "$(db_value "SELECT group_concat(label, ', ') FROM (SELECT label FROM assignment_items WHERE assignment_id = '$ASSIGNMENT_ID' ORDER BY position)")" \
  "№ 12, № 13, № 14"

# ---------------------------------------------------------------------------
# b) The prompt summary and the list tool see the assignment
# ---------------------------------------------------------------------------

section "b) assignment summary in the prompt (SSE)"

write_text_body "$SCRATCH/list.json" "$PARENT_LIST_TEXT" true
HTTP_CODE="$(api -N -o "$SCRATCH/list.sse" -D "$SCRATCH/list.headers" -w '%{http_code}' \
  -H "Authorization: Bearer $PARENT_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary "@$SCRATCH/list.json" \
  "http://127.0.0.1:${PORT}/v1/chat/completions")"
expect_eq "parent list (stream) → 200" "$HTTP_CODE" "200"
if grep -qi '^content-type: text/event-stream' "$SCRATCH/list.headers"; then
  ok "parent list → content-type: text/event-stream"
else
  fail "parent list → wrong or missing content-type"
fi
if [ "$(grep '^data: ' "$SCRATCH/list.sse" | tail -1)" = "data: [DONE]" ]; then
  ok "the SSE stream ends with data: [DONE]"
else
  fail "the SSE stream does not end with data: [DONE]"
fi

sed -n 's/^data: //p' "$SCRATCH/list.sse" | grep -v '^\[DONE\]$' >"$SCRATCH/list.chunks"
jq -s -r '[.[].choices[]?.delta.content // empty] | join("")' "$SCRATCH/list.chunks" >"$SCRATCH/list.txt" || true
LIST_TEXT="$(cat "$SCRATCH/list.txt")"
expect_text_has "the streamed answer carries the real list_assignments result" "$LIST_TEXT" "Задания (1 из 1)"
expect_text_has "the list names the subject" "$LIST_TEXT" "«Математика»"
expect_text_has "the list shows the items" "$LIST_TEXT" "№ 12"
expect_text_has "the list shows the deadline and status" "$LIST_TEXT" "ждёт отчёта"

PROMPT="$(prompt_sections)"
expect_text_has "the system prompt carries the SPEC §6 assignment section" "$PROMPT" "# Активные задания"
expect_text_has "the prompt summary contains the new assignment" "$PROMPT" "Математика — ждёт отчёта"
expect_eq "the stored due instant is the one the script asked for" \
  "$(db_value "SELECT due_at FROM assignments WHERE id = '$ASSIGNMENT_ID'")" \
  "2099-01-01T10:00:00.000Z"

# ---------------------------------------------------------------------------
# c) Child reports with a photo → check-in, in_review, verify task
# ---------------------------------------------------------------------------

section "c) child reports with a photo"

jq -n \
  --arg text "$CHILD_REPORT_TEXT" \
  --arg url "data:image/png;base64,$PNG_BASE64" \
  '{
    model: "hmwrk",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: $text },
        { type: "image_url", image_url: { url: $url } }
      ]
    }]
  }' >"$SCRATCH/report.json"

HTTP_CODE="$(post_chat "$CHILD_KEY" "$SCRATCH/report.json" "$SCRATCH/report.response.json")"
expect_eq "child report → 200" "$HTTP_CODE" "200"
expect_answer_has "the agent accepts the report" "$SCRATCH/report.response.json" "Отчёт по «Математика» принят (1 фото)"
expect_answer_has "the assignment moved to review" "$SCRATCH/report.response.json" "на проверке"
expect_answer_has "the verification task started" "$SCRATCH/report.response.json" "Проверка запущена"

expect_eq "one photo row was created" "$(db_value 'SELECT count(*) FROM photos')" "1"
expect_eq "the photo is stored as a check-in image" \
  "$(db_value 'SELECT kind FROM photos LIMIT 1')" "checkin"
expect_eq "the MIME is detected from the bytes, not from the caller" \
  "$(db_value 'SELECT mime FROM photos LIMIT 1')" "image/png"
PHOTO_PATH="$(db_value 'SELECT path FROM photos LIMIT 1')"
if [ -n "$PHOTO_PATH" ] && [ -s "$DATA_DIR/photos/$PHOTO_PATH" ]; then
  ok "the photo bytes exist on disk ($PHOTO_PATH)"
else
  fail "the photo file is missing under $DATA_DIR/photos ($PHOTO_PATH)"
fi
expect_eq "one check-in row was created" "$(db_value 'SELECT count(*) FROM checkins')" "1"
expect_eq "the check-in links the photo" "$(db_value 'SELECT count(*) FROM checkin_photos')" "1"
expect_eq "the child's comment is stored" \
  "$(db_value 'SELECT comment FROM checkins LIMIT 1')" "№ 13 не уверен"
expect_eq "the assignment is in_review" \
  "$(db_value "SELECT status FROM assignments WHERE id = '$ASSIGNMENT_ID'")" "in_review"

if wait_db_value "SELECT count(*) FROM verifications WHERE status = 'draft'" "1" 150; then
  ok "the verify task stored a draft verdict"
else
  fail "the verify task did not store a draft verdict in time"
fi
VERIFICATION_ID="$(db_value 'SELECT id FROM verifications LIMIT 1')"
expect_eq "the draft was produced by the faux verify slot" \
  "$(db_value 'SELECT model FROM verifications LIMIT 1')" "faux-verify"
expect_eq "the draft has one finding per item" \
  "$(db_value 'SELECT count(*) FROM verification_findings')" "3"
expect_eq "the findings follow the verdict JSON" \
  "$(db_value 'SELECT group_concat(verdict) FROM (SELECT verdict FROM verification_findings ORDER BY rowid)')" \
  "ok,missing,ok"
expect_text_has "the draft summary is a real model answer" \
  "$(db_value 'SELECT summary FROM verifications LIMIT 1')" "№ 12 и № 14 решены верно"
expect_file_has "verify log: photos transcribed" "$LOG" '"msg":"verify: photos transcribed"'
expect_file_has "verify log: model verdict ready" "$LOG" '"msg":"verify: model verdict ready"'
expect_file_has "verify log: draft saved" "$LOG" '"msg":"verify: draft verification saved"'

# ---------------------------------------------------------------------------
# d) Parent sees the draft; the child does not
# ---------------------------------------------------------------------------

section "d) draft verdict visible to the parent only"

write_text_body "$SCRATCH/verdicts-parent.json" "$PARENT_VERDICTS_TEXT"
HTTP_CODE="$(post_chat "$PARENT_KEY" "$SCRATCH/verdicts-parent.json" "$SCRATCH/verdicts-parent.response.json")"
expect_eq "parent verdicts → 200" "$HTTP_CODE" "200"
expect_answer_has "the parent sees the draft status" "$SCRATCH/verdicts-parent.response.json" "черновик (ждёт решения родителя)"
expect_answer_has "the parent sees the real summary" "$SCRATCH/verdicts-parent.response.json" "резюме: № 12 и № 14 решены верно"
expect_answer_has "the parent sees the per-item verdict" "$SCRATCH/verdicts-parent.response.json" "№ 12: верно"
expect_answer_has "the parent sees the missing item" "$SCRATCH/verdicts-parent.response.json" "№ 13: не найдено"
expect_answer_has "the verdict is attributed to the faux verify model" "$SCRATCH/verdicts-parent.response.json" "faux-verify"

write_text_body "$SCRATCH/verdicts-child-draft.json" "$CHILD_VERDICTS_DRAFT_TEXT"
HTTP_CODE="$(post_chat "$CHILD_KEY" "$SCRATCH/verdicts-child-draft.json" "$SCRATCH/verdicts-child-draft.response.json")"
expect_eq "child verdicts (draft stage) → 200" "$HTTP_CODE" "200"
expect_answer_has "the child is told there is no approved verdict yet" \
  "$SCRATCH/verdicts-child-draft.response.json" "Утверждённых вердиктов пока нет"
expect_answer_lacks "the child does not see the draft's id" \
  "$SCRATCH/verdicts-child-draft.response.json" "$VERIFICATION_ID"

# ---------------------------------------------------------------------------
# e) Parent approves → done; the child sees the verdict
# ---------------------------------------------------------------------------

section "e) approve → done, then the child sees the verdict"

write_text_body "$SCRATCH/approve.json" "$PARENT_APPROVE_TEXT"
HTTP_CODE="$(post_chat "$PARENT_KEY" "$SCRATCH/approve.json" "$SCRATCH/approve.response.json")"
expect_eq "parent approve → 200" "$HTTP_CODE" "200"
expect_answer_has "the approval names the terminal assignment state" \
  "$SCRATCH/approve.response.json" "Вердикт утверждён: «Математика» — сдано"
expect_answer_has "the approval says the child will see it" \
  "$SCRATCH/approve.response.json" "Ребёнок теперь увидит вердикт"

expect_eq "the verification is approved" \
  "$(db_value 'SELECT status FROM verifications LIMIT 1')" "approved"
DECIDED_BY="$(db_value 'SELECT decided_by_user_id FROM verifications LIMIT 1')"
if [ -n "$DECIDED_BY" ]; then
  ok "the decision records the parent"
else
  fail "the decision has no deciding parent"
fi
expect_eq "the assignment is done" \
  "$(db_value "SELECT status FROM assignments WHERE id = '$ASSIGNMENT_ID'")" "done"

write_text_body "$SCRATCH/verdicts-child-after.json" "$CHILD_VERDICTS_TEXT"
HTTP_CODE="$(post_chat "$CHILD_KEY" "$SCRATCH/verdicts-child-after.json" "$SCRATCH/verdicts-child-after.response.json")"
expect_eq "child verdicts (after approval) → 200" "$HTTP_CODE" "200"
expect_answer_has "the child sees the approved verdict" \
  "$SCRATCH/verdicts-child-after.response.json" "Утверждённые вердикты (1)"
expect_answer_has "the verdict is marked approved" \
  "$SCRATCH/verdicts-child-after.response.json" "утверждён"
expect_answer_has "the child sees the per-item result" \
  "$SCRATCH/verdicts-child-after.response.json" "№ 12: верно"
expect_answer_has "the child sees the verdict id" \
  "$SCRATCH/verdicts-child-after.response.json" "$VERIFICATION_ID"

# ---------------------------------------------------------------------------
# f) Overdue: derived state, not stored
# ---------------------------------------------------------------------------

section "f) overdue assignment"

write_text_body "$SCRATCH/add-russian.json" "$PARENT_OVERDUE_ADD_TEXT"
HTTP_CODE="$(post_chat "$PARENT_KEY" "$SCRATCH/add-russian.json" "$SCRATCH/add-russian.response.json")"
expect_eq "parent adds a past-due assignment → 200" "$HTTP_CODE" "200"
expect_answer_has "the agent created the overdue assignment" \
  "$SCRATCH/add-russian.response.json" "Добавил задание: «Русский язык»"
expect_answer_has "the agent says the deadline already passed" \
  "$SCRATCH/add-russian.response.json" "просроченное"

write_text_body "$SCRATCH/overdue.json" "$PARENT_OVERDUE_TEXT"
HTTP_CODE="$(post_chat "$PARENT_KEY" "$SCRATCH/overdue.json" "$SCRATCH/overdue.response.json")"
expect_eq "parent overdue list → 200" "$HTTP_CODE" "200"
expect_answer_has "the overdue list contains the past-due assignment" \
  "$SCRATCH/overdue.response.json" "«Русский язык»"
expect_answer_has "the list marks it as overdue" \
  "$SCRATCH/overdue.response.json" "просрочено"
expect_answer_lacks "the done assignment is not in the overdue list" \
  "$SCRATCH/overdue.response.json" "«Математика»"

expect_eq "the overdue assignment is still stored as active" \
  "$(db_value "SELECT status FROM assignments WHERE subject = 'Русский язык'")" "active"
PROMPT_AFTER="$(prompt_sections)"
expect_text_has "the prompt summary marks the overdue assignment" \
  "$PROMPT_AFTER" "Русский язык — ждёт отчёта, просрочено"

# ---------------------------------------------------------------------------
# g) Idempotent retry, auth still valid
# ---------------------------------------------------------------------------

section "g) requestId retry does not duplicate"

USER_ENTRIES_BEFORE="$(db_value "SELECT count(*) FROM pi_entries WHERE json_extract(record, char(36) || '.kind') = 'pi.user'")"
ENTRIES_BEFORE="$(db_value 'SELECT count(*) FROM pi_entries')"
ENTRIES_AFTER_FIRST=""

write_text_body "$SCRATCH/retry.json" "$RETRY_TEXT"
HTTP_CODE="$(post_chat "$PARENT_KEY" "$SCRATCH/retry.json" "$SCRATCH/retry-1.response.json" \
  -H 'X-Request-Id: m2-retry-1')"
expect_eq "first attempt with X-Request-Id → 200" "$HTTP_CODE" "200"
USER_ENTRIES_AFTER_FIRST="$(db_value "SELECT count(*) FROM pi_entries WHERE json_extract(record, char(36) || '.kind') = 'pi.user'")"
expect_eq "the first attempt adds exactly one user entry" \
  "$USER_ENTRIES_AFTER_FIRST" "$((USER_ENTRIES_BEFORE + 1))"
ENTRIES_AFTER_FIRST="$(db_value 'SELECT count(*) FROM pi_entries')"
if [ "$ENTRIES_AFTER_FIRST" -gt "$ENTRIES_BEFORE" ]; then
  ok "the first attempt added durable entries (answer recorded)"
else
  fail "the first attempt added no durable entries (before=$ENTRIES_BEFORE after=$ENTRIES_AFTER_FIRST)"
fi
expect_eq "the first attempt is recorded as one submission" \
  "$(db_value "SELECT count(*) FROM pi_submissions WHERE json_extract(request_id, char(36)) = 'm2-retry-1'")" "1"

HTTP_CODE="$(post_chat "$PARENT_KEY" "$SCRATCH/retry.json" "$SCRATCH/retry-2.response.json" \
  -H 'X-Request-Id: m2-retry-1')"
expect_eq "retry with the same X-Request-Id → 200" "$HTTP_CODE" "200"
expect_eq "the retry returns the same answer" \
  "$(answer_text "$SCRATCH/retry-1.response.json")" \
  "$(answer_text "$SCRATCH/retry-2.response.json")"
expect_eq "the retry adds no user entry" \
  "$(db_value "SELECT count(*) FROM pi_entries WHERE json_extract(record, char(36) || '.kind') = 'pi.user'")" "$USER_ENTRIES_AFTER_FIRST"
expect_eq "the retry adds no durable entries at all" \
  "$(db_value 'SELECT count(*) FROM pi_entries')" "$ENTRIES_AFTER_FIRST"
expect_eq "the retry still has exactly one submission" \
  "$(db_value "SELECT count(*) FROM pi_submissions WHERE json_extract(request_id, char(36)) = 'm2-retry-1'")" "1"

# Two actors + the household root conversation that owns the verify task (K3/K9).
expect_eq "parent, child and the verify-task root keep three conversations" \
  "$(db_value 'SELECT count(*) FROM pi_conversations')" "3"

HTTP_CODE="$(api -o "$SCRATCH/no-key-after.json" -w '%{http_code}' "http://127.0.0.1:${PORT}/v1/models")"
expect_eq "401 still holds after the cycle" "$HTTP_CODE" "401"
HTTP_CODE="$(api -o "$SCRATCH/bad-key-after.json" -w '%{http_code}' \
  -H "Authorization: Bearer not-a-configured-key" \
  "http://127.0.0.1:${PORT}/v1/models")"
expect_eq "unknown key still gets 401 after the cycle" "$HTTP_CODE" "401"

# ---------------------------------------------------------------------------
# Stop and log hygiene
# ---------------------------------------------------------------------------

section "shutdown and logs"

stop_core "after the M2 cycle"

expect_file_has "shutdown log confirms a graceful close" "$LOG" '"msg":"hmwrk stopped"'

if grep -h '"level":"error"' "$LOG"; then
  fail "error-level records found in the server log"
else
  ok "no error-level log records"
fi

UNEXPECTED_WARNINGS="$(grep -h '"level":"warn"' "$LOG" |
  grep -v '"msg":"request rejected"' |
  grep -v 'HMWRK_FAUX_LLM is on' || true)"
if [ -n "$UNEXPECTED_WARNINGS" ]; then
  fail "unexpected warnings in the server log"
  printf '%s\n' "$UNEXPECTED_WARNINGS"
else
  ok "no warnings besides the expected 401s and the faux hook notice"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

printf '\n'
if [ "$FAIL_COUNT" -ne 0 ]; then
  say "M2 verification FAILED: $FAIL_COUNT failed, $PASS_COUNT passed"
  exit 1
fi
say "M2 verification passed: $PASS_COUNT checks, 0 failed"
