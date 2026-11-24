#!/usr/bin/env bash
#
# M3 end-to-end verification (plan I3, milestone-3 merge gate).
#
# Boots the real core (`node --import tsx src/index.ts`) over a throwaway DATA_DIR in $TMPDIR with
# fake role keys and **pi-ai's faux provider** (`HMWRK_FAUX_LLM=1`, script generated from
# `scripts/fixtures/faux-m3.json`), plus `scripts/mock-telegram.mjs` as the Bot API
# (`TELEGRAM_API_URL`), so the whole broadcast path runs without keys and without network.
#
# What the run proves, in order:
#
#   a) boot + bind: both static keys own a `users` row, `scripts/bind-telegram.ts` binds the two
#      Telegram chats, the reminder/digest tasks are scheduled and visible in `pi_tasks`;
#   b) `set_setting` through the chat moves `reminder_time` / `digest_time` to «now + ~1 min», and the
#      answer says the schedule was rebuilt (the notification tasks are recreated, not left sleeping
#      until tomorrow);
#   c) parent adds an assignment due tomorrow, the child reports with a photo, the durable verify task
#      produces a draft verdict, a second assignment is overdue, and the screenshot intake returns a
#      structured draft (`kind=screenshot` in `photos`);
#   d) at `reminder_time` the child chat receives the reminder — with the unreported assignment due
#      *tomorrow* evening (the I3 window fix), without the reported one, subject HTML-escaped;
#   e) at `digest_time` the parent chat receives the digest with three sections (сдано / просрочено /
#      ждут утверждения), also escaped, sent with `parse_mode: HTML`;
#   f) `paused_until = today` mutes the next digest: the task fires, is skipped as `paused`, and no
#      message reaches the parent chat.
#
# Usage (from the repo root or anywhere):
#
#   bash scripts/verify-m3.sh
#
# Exits 0 only when every check passed. On failure the scratch directory (server log, mock Telegram
# log, responses, SQLite) is printed and kept; KEEP_ARTIFACTS=1 keeps it on success too.
#
# Requirements: Node >= 22 with devDependencies installed (`npm ci`), curl, jq. `sqlite3` is
# preferred; without it the script falls back to `node:sqlite`. The run waits for real wall-clock
# minutes (the schedule is minute-granular by design), typically 3–5 minutes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PARENT_KEY="hmwrk-m3-parent-test-key"
CHILD_KEY="hmwrk-m3-child-test-key"
BOT_TOKEN="123456789:hmwrk-m3-test-token"
PARENT_CHAT="111"
CHILD_CHAT="222"

PARENT_REMINDER_TEXT="напоминание поставь на ближайшее время"
PARENT_DIGEST_TEXT="дайджест тоже перенеси на ближайшее время"
PARENT_ADD_TEXT="добавь математику на завтра"
PARENT_ADD_LIT_TEXT="добавь литературу на завтра"
CHILD_REPORT_TEXT="сделал математику"
PARENT_OVERDUE_TEXT="добавь русский язык вчера"
PARENT_SCREENSHOT_TEXT="прочитай скриншот дневника"
PARENT_PAUSE_TEXT="поставь паузу на сегодня"
PARENT_DIGEST_LATE_TEXT="сдвинь дайджест ещё раз"

# A minimal but signature-valid 1×1 PNG (the store checks magic bytes, not pixels).
PNG_BASE64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

PASS_COUNT=0
FAIL_COUNT=0
SERVER_PID=""
MOCK_PID=""
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
    say "verify-m3: required command not found: $1" >&2
    exit 2
  fi
}

require_command node
require_command curl
require_command jq

if [ ! -d node_modules ]; then
  say "verify-m3: node_modules is missing; run 'npm ci' in $REPO_ROOT first" >&2
  exit 2
fi

FIXTURE_TEMPLATE="$REPO_ROOT/scripts/fixtures/faux-m3.json"
MOCK_SERVER="$REPO_ROOT/scripts/mock-telegram.mjs"
for file in "$FIXTURE_TEMPLATE" "$MOCK_SERVER"; do
  if [ ! -f "$file" ]; then
    say "verify-m3: missing file: $file" >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Scratch space, data directory, ports
# ---------------------------------------------------------------------------

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/hmwrk-m3.XXXXXX")"
DATA_DIR="$SCRATCH/data"
LOG="$SCRATCH/server.log"
MOCK_LOG="$SCRATCH/mock-telegram.log"
MOCK_SERVER_LOG="$SCRATCH/mock-telegram.out"
FIXTURE="$SCRATCH/faux-m3.json"
mkdir -p "$DATA_DIR"
DB="$DATA_DIR/hmwrk.sqlite"
: >"$MOCK_LOG"

cleanup() {
  for pid in "$SERVER_PID" "$MOCK_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [ "$FAIL_COUNT" -ne 0 ] || [ "$KEEP_ARTIFACTS" = "1" ]; then
    say "verify-m3: artifacts kept in $SCRATCH"
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
  say "verify-m3: could not find a free port for the server" >&2
  exit 2
}
MOCK_PORT="$(pick_port)" || {
  say "verify-m3: could not find a free port for the Telegram mock" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Time helpers (the schedule is HH:MM local, so nothing can be faster than a minute)
# ---------------------------------------------------------------------------

# Prints "<HH:MM> <seconds-from-now>": the first minute boundary at least `minAheadSeconds` ahead
# (+20 s, so the commit that stores the setting cannot land in the same minute).
#
# `reminder_time` is minute-granular and `nextRunAt` is strictly-greater: a target in the *current*
# minute is read as «tomorrow». Every mark therefore gets its own future minute, and the three marks
# are forced apart below — the run needs a reminder window, a digest window and a second, muted one.
next_hhmm() { # minAheadSeconds
  node -e '
    const now = Date.now();
    const target = new Date(now + (Number(process.argv[1]) + 20) * 1000);
    const floored = new Date(
      target.getFullYear(), target.getMonth(), target.getDate(), target.getHours(), target.getMinutes(), 0, 0,
    );
    const boundary = floored.getTime() === target.getTime() ? floored : new Date(floored.getTime() + 60_000);
    const hh = String(boundary.getHours()).padStart(2, "0");
    const mm = String(boundary.getMinutes()).padStart(2, "0");
    process.stdout.write(`${hh}:${mm} ${Math.round((boundary.getTime() - now) / 1000)}`);
  ' "$1"
}

read -r REMINDER_TIME REMINDER_WAIT <<<"$(next_hhmm 45)"
read -r DIGEST_TIME DIGEST_WAIT <<<"$(next_hhmm $((REMINDER_WAIT + 60)))"
# The third window: by then `paused_until` is set, so this firing must be muted.
read -r DIGEST_LATE_TIME DIGEST_LATE_WAIT <<<"$(next_hhmm $((DIGEST_WAIT + 60)))"
while [ "$DIGEST_TIME" = "$REMINDER_TIME" ]; do
  read -r DIGEST_TIME DIGEST_WAIT <<<"$(next_hhmm $((DIGEST_WAIT + 60)))"
done
while [ "$DIGEST_LATE_TIME" = "$DIGEST_TIME" ]; do
  read -r DIGEST_LATE_TIME DIGEST_LATE_WAIT <<<"$(next_hhmm $((DIGEST_LATE_WAIT + 60)))"
done

TODAY="$(date +%F)"
# `formatDay` in the tool answers prints the household format, not ISO.
TODAY_RU="$(date +%d.%m.%Y)"
MATH_DUE="$(node -e '
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 20, 0, 0, 0);
  process.stdout.write(due.toISOString());
')"
LIT_DUE="$(node -e '
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 21, 30, 0, 0);
  process.stdout.write(due.toISOString());
')"
RUSSIAN_DUE="$(node -e '
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 20, 0, 0, 0);
  process.stdout.write(due.toISOString());
')"
GEO_DUE="$(node -e '
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 20, 0, 0, 0);
  const yyyy = due.getFullYear();
  const mm = String(due.getMonth() + 1).padStart(2, "0");
  const dd = String(due.getDate()).padStart(2, "0");
  process.stdout.write(`${yyyy}-${mm}-${dd}`);
')"

# The faux script needs the run's times, so the checked-in template is filled in here.
sed -e "s|__REMINDER_TIME__|$REMINDER_TIME|" \
  -e "s|__DIGEST_TIME__|$DIGEST_TIME|" \
  -e "s|__DIGEST_LATE__|$DIGEST_LATE_TIME|" \
  -e "s|__MATH_DUE__|$MATH_DUE|" \
  -e "s|__LIT_DUE__|$LIT_DUE|" \
  -e "s|__RUSSIAN_DUE__|$RUSSIAN_DUE|" \
  -e "s|__GEO_DUE__|$GEO_DUE|" \
  -e "s|__TODAY__|$TODAY|" \
  "$FIXTURE_TEMPLATE" >"$FIXTURE"

# K8 model slots from R1; the faux hook replaces them at boot, but config still validates models.json.
cat >"$DATA_DIR/models.json" <<'JSON'
{
  "read": { "provider": "groq", "modelId": "qwen/qwen3.6-27b" },
  "verify": { "provider": "mistral", "modelId": "deepseek-v4-1-flash-1017" },
  "chat": { "provider": "mistral", "modelId": "deepseek-v4-1-flash-1017" }
}
JSON

say "verify-m3: repo=$REPO_ROOT"
say "verify-m3: scratch=$SCRATCH"
say "verify-m3: port=$PORT mock-telegram=$MOCK_PORT"
say "verify-m3: reminder_time=$REMINDER_TIME (${REMINDER_WAIT}s) digest_time=$DIGEST_TIME (${DIGEST_WAIT}s)"
say "verify-m3: paused digest window=$DIGEST_LATE_TIME (${DIGEST_LATE_WAIT}s)"

# ---------------------------------------------------------------------------
# Boot helpers
# ---------------------------------------------------------------------------

start_mock() {
  MOCK_TELEGRAM_PORT="$MOCK_PORT" \
    MOCK_TELEGRAM_LOG="$MOCK_LOG" \
    node "$MOCK_SERVER" >"$MOCK_SERVER_LOG" 2>&1 &
  MOCK_PID=$!
}

wait_for_mock() {
  local attempt
  for attempt in $(seq 1 100); do
    if grep -q "mock telegram listening" "$MOCK_SERVER_LOG" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$MOCK_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.1
  done
  return 1
}

start_core() {
  PORT="$PORT" \
    DATA_DIR="$DATA_DIR" \
    LOG_LEVEL=debug \
    HMWRK_PARENT_KEY="$PARENT_KEY" \
    HMWRK_CHILD_KEY="$CHILD_KEY" \
    HMWRK_FAUX_LLM=1 \
    HMWRK_FAUX_SCRIPT="$FIXTURE" \
    TELEGRAM_BOT_TOKEN="$BOT_TOKEN" \
    TELEGRAM_API_URL="http://127.0.0.1:${MOCK_PORT}" \
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

# One POST /v1/chat/completions; prints the HTTP code and writes the body.
post_chat() { # key body-file out-file
  local key="$1"
  local body="$2"
  local out="$3"
  api -o "$out" -w '%{http_code}' \
    -H "Authorization: Bearer $key" \
    -H 'Content-Type: application/json' \
    --data-binary "@$body" \
    "http://127.0.0.1:${PORT}/v1/chat/completions"
}

write_text_body() { # out-file text
  jq -n --arg content "$2" \
    '{ model: "hmwrk", stream: false, messages: [{ role: "user", content: $content }] }' >"$1"
}

# One parent/child turn driven through the OpenAI-compatible endpoint.
say_as() { # key label out-file text
  local key="$1"
  local label="$2"
  local out="$3"
  local text="$4"
  local body="$SCRATCH/request.json"
  write_text_body "$body" "$text"
  local code
  code="$(post_chat "$key" "$body" "$out")"
  expect_eq "$label → 200" "$code" "200"
}

# Mock Telegram: every message the server sent, as JSON lines.
mock_json() {
  if [ ! -s "$MOCK_LOG" ]; then
    return 0
  fi
  jq -c '.' "$MOCK_LOG" 2>/dev/null || true
}

mock_messages_to() { # chatId
  if [ ! -s "$MOCK_LOG" ]; then
    return 0
  fi
  jq -r --arg chat "$1" 'select(.chat_id == $chat) | .text' "$MOCK_LOG" 2>/dev/null || true
}

mock_count_to() { # chatId
  if [ ! -s "$MOCK_LOG" ]; then
    printf '0'
    return 0
  fi
  jq -s --arg chat "$1" '[ .[] | select(.chat_id == $chat) ] | length' "$MOCK_LOG" 2>/dev/null || printf '0'
}

mock_parse_modes_to() { # chatId
  if [ ! -s "$MOCK_LOG" ]; then
    return 0
  fi
  jq -s -r --arg chat "$1" '[ .[] | select(.chat_id == $chat) | .parse_mode ] | unique | join(",")' "$MOCK_LOG" 2>/dev/null || true
}

wait_mock_text() { # chatId needle timeoutSeconds
  local chat="$1"
  local needle="$2"
  local attempts=$(( $3 * 2 ))
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if mock_messages_to "$chat" | grep -qF -- "$needle"; then
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.5
  done
  return 1
}

wait_log_line() { # needle timeoutSeconds
  local needle="$1"
  local attempts=$(( $2 * 2 ))
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if grep -qF -- "$needle" "$LOG" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.5
  done
  return 1
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
  say "verify-m3: neither sqlite3 nor node:sqlite can read $DB" >&2
  exit 2
}

db_value() {
  if [ "$DB_MODE" = "sqlite3" ]; then
    sqlite3 "$DB" "$1"
    return 0
  fi
  node ${NODE_SQLITE_FLAG:+"$NODE_SQLITE_FLAG"} --input-type=module -e "$NODE_DB_VALUE" "$DB" "$1"
}

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

# ---------------------------------------------------------------------------
# a) boot, notify tasks, chat bindings
# ---------------------------------------------------------------------------

section "a) boot with a Telegram mock and bind the chats"

start_mock
if wait_for_mock; then
  ok "mock Telegram API listens on 127.0.0.1:$MOCK_PORT"
else
  fail "mock Telegram API did not start"
  say "--- $MOCK_SERVER_LOG ---"
  cat "$MOCK_SERVER_LOG" || true
  exit 1
fi

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

expect_file_has "boot log: the notify extension is installed" "$LOG" '"msg":"notify extension installed"'
expect_file_has "boot log: both broadcast tasks are scheduled" "$LOG" '"msg":"notify tasks scheduled"'

# `pi_tasks.kind` is stored JSON-encoded by the storage adapter (quoted), hence the strip.
expect_eq "exactly one reminder and one digest task are live" \
  "$(db_value "SELECT count(*) FROM pi_tasks WHERE replace(kind, '\"', '') IN ('hmwrk.reminder', 'hmwrk.digest')")" "2"
expect_eq "the two static keys own a users row each" "$(db_value 'SELECT count(*) FROM users')" "2"

BIND_ENV=(env DATA_DIR="$DATA_DIR" HMWRK_PARENT_KEY="$PARENT_KEY" HMWRK_CHILD_KEY="$CHILD_KEY")
if "${BIND_ENV[@]}" node --import tsx scripts/bind-telegram.ts parent "$PARENT_CHAT" >"$SCRATCH/bind-parent.log" 2>&1; then
  ok "bind-telegram: the parent chat is bound"
else
  fail "bind-telegram: the parent chat was not bound"
  cat "$SCRATCH/bind-parent.log" || true
fi
if "${BIND_ENV[@]}" node --import tsx scripts/bind-telegram.ts child "$CHILD_CHAT" >"$SCRATCH/bind-child.log" 2>&1; then
  ok "bind-telegram: the child chat is bound"
else
  fail "bind-telegram: the child chat was not bound"
  cat "$SCRATCH/bind-child.log" || true
fi
expect_eq "both chat bindings are stored" "$(db_value 'SELECT count(*) FROM tg_bindings')" "2"
expect_eq "the bindings point at the two expected chats" \
  "$(db_value "SELECT group_concat(chat_id, ',') FROM (SELECT chat_id FROM tg_bindings ORDER BY chat_id)")" \
  "$PARENT_CHAT,$CHILD_CHAT"

# ---------------------------------------------------------------------------
# b) set_setting moves the schedule (I3)
# ---------------------------------------------------------------------------

section "b) set_setting через чат переносит расписание"

say_as "$PARENT_KEY" "parent sets reminder_time" "$SCRATCH/set-reminder.response.json" "$PARENT_REMINDER_TEXT"
expect_answer_has "the tool reports the new reminder time" "$SCRATCH/set-reminder.response.json" "reminder_time изменена"
expect_answer_has "…with the requested value" "$SCRATCH/set-reminder.response.json" "$REMINDER_TIME"
expect_answer_has "the schedule was rebuilt, not left until tomorrow" \
  "$SCRATCH/set-reminder.response.json" "Расписание напоминаний пересобрано"
expect_eq "reminder_time is stored" "$(db_value "SELECT value FROM settings WHERE key = 'reminder_time'")" "\"$REMINDER_TIME\""

say_as "$PARENT_KEY" "parent sets digest_time" "$SCRATCH/set-digest.response.json" "$PARENT_DIGEST_TEXT"
expect_answer_has "the tool reports the new digest time" "$SCRATCH/set-digest.response.json" "digest_time изменена"
expect_answer_has "the digest schedule was rebuilt" \
  "$SCRATCH/set-digest.response.json" "Расписание дайджеста пересобрано"

# The previous tasks were ended and recreated: still exactly two live broadcasts, no duplicates.
expect_eq "the reschedule left exactly one task per kind" \
  "$(db_value "SELECT count(*) FROM pi_tasks WHERE replace(kind, '\"', '') IN ('hmwrk.reminder', 'hmwrk.digest') AND status != 'terminal'")" "2"

# ---------------------------------------------------------------------------
# c) data for both broadcasts: tomorrow's homework, a report, an overdue one, a screenshot
# ---------------------------------------------------------------------------

section "c) задания, отчёт ребёнка и скриншот"

say_as "$PARENT_KEY" "parent adds tomorrow's assignment" "$SCRATCH/add-math.response.json" "$PARENT_ADD_TEXT"
expect_answer_has "the assignment is created" "$SCRATCH/add-math.response.json" "Добавил задание"
expect_eq "the assignment is stored as active" \
  "$(db_value "SELECT status || '/' || source FROM assignments WHERE subject = 'Математика <5.1>'")" "active/manual"

say_as "$PARENT_KEY" "parent adds tomorrow's reading" "$SCRATCH/add-literature.response.json" "$PARENT_ADD_LIT_TEXT"
expect_answer_has "the second assignment is created" "$SCRATCH/add-literature.response.json" "Добавил задание"

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
expect_eq "child reports with a photo → 200" "$HTTP_CODE" "200"
expect_answer_has "the report is accepted" "$SCRATCH/report.response.json" "на проверке"
expect_eq "one check-in is stored" "$(db_value 'SELECT count(*) FROM checkins')" "1"

if wait_db_value "SELECT count(*) FROM verifications WHERE status = 'draft'" "1" 150; then
  ok "the durable verify task stored a draft verdict"
else
  fail "the verify task did not produce a draft verdict"
fi

say_as "$PARENT_KEY" "parent adds an overdue assignment" "$SCRATCH/add-russian.response.json" "$PARENT_OVERDUE_TEXT"
expect_answer_has "the overdue assignment is created" "$SCRATCH/add-russian.response.json" "Добавил задание"
expect_eq "it stays active although past due (derived state)" \
  "$(db_value "SELECT status FROM assignments WHERE subject = 'Русский язык'")" "active"

jq -n \
  --arg text "$PARENT_SCREENSHOT_TEXT" \
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
  }' >"$SCRATCH/screenshot.json"
HTTP_CODE="$(post_chat "$PARENT_KEY" "$SCRATCH/screenshot.json" "$SCRATCH/screenshot.response.json")"
expect_eq "parent sends a screenshot → 200" "$HTTP_CODE" "200"
expect_answer_has "the intake answers with a structured draft" \
  "$SCRATCH/screenshot.response.json" "Разобрал 1 фото в черновик заданий"
expect_answer_has "the draft lists the subject it read" "$SCRATCH/screenshot.response.json" "География"
expect_answer_has "…and the items" "$SCRATCH/screenshot.response.json" "§ 12"
expect_answer_has "…and asks for confirmation instead of creating" \
  "$SCRATCH/screenshot.response.json" "нужно подтверждение родителя"
expect_eq "the parent's screenshot is stored with kind=screenshot" \
  "$(db_value "SELECT kind FROM photos WHERE kind = 'screenshot'")" "screenshot"
expect_eq "the check-in photo is stored with kind=checkin" \
  "$(db_value "SELECT count(*) FROM photos WHERE kind = 'checkin'")" "1"

# ---------------------------------------------------------------------------
# d) the child reminder fires on schedule
# ---------------------------------------------------------------------------

section "d) напоминание ребёнку по расписанию"

if wait_mock_text "$CHILD_CHAT" "Завтра сдать" "$((REMINDER_WAIT + 150))"; then
  ok "the reminder reached the child chat"
else
  fail "no reminder reached the child chat within $((REMINDER_WAIT + 150))s"
fi
REMINDER_TEXT="$(mock_messages_to "$CHILD_CHAT")"
expect_text_has "the reminder carries tomorrow's assignment (I3 window: end of the next local day)" \
  "$REMINDER_TEXT" "Литература &amp; чтение"
expect_text_has "the reminder lists the items" "$REMINDER_TEXT" "стр. 40"
expect_text_has "the reminder names the deadline" "$REMINDER_TEXT" "Не забудь отчитаться"
expect_text_lacks "a reported assignment is not reminded" "$REMINDER_TEXT" "Математика"
expect_text_lacks "the overdue assignment is not in the child reminder" "$REMINDER_TEXT" "Русский язык"
expect_text_lacks "user data is escaped, no raw ampersand" "$REMINDER_TEXT" "Литература & чтение"
expect_eq "the reminder was sent with parse_mode=HTML" "$(mock_parse_modes_to "$CHILD_CHAT")" "HTML"
expect_file_has "server log: the reminder firing was recorded" "$LOG" '"kind":"reminder"'

# ---------------------------------------------------------------------------
# e) the parent digest fires on schedule
# ---------------------------------------------------------------------------

section "e) дайджест родителю по расписанию"

if wait_mock_text "$PARENT_CHAT" "Итоги дня" "$((DIGEST_WAIT + 150))"; then
  ok "the digest reached the parent chat"
else
  fail "no digest reached the parent chat within $((DIGEST_WAIT + 150))s"
fi
DIGEST_TEXT="$(mock_messages_to "$PARENT_CHAT")"
expect_text_has "the digest has the «сдано сегодня» section" "$DIGEST_TEXT" "Сдано сегодня"
expect_text_has "…with the child's comment" "$DIGEST_TEXT" "№ 13 не уверен"
expect_text_has "the digest has the «просрочено» section" "$DIGEST_TEXT" "Просрочено"
expect_text_has "…with the past-due assignment" "$DIGEST_TEXT" "Русский язык"
expect_text_has "the digest has the «ждут утверждения» section" "$DIGEST_TEXT" "Ждут утверждения"
expect_text_has "…with the verdict summary" "$DIGEST_TEXT" "№ 12 решено верно"
expect_text_has "the subject is HTML-escaped in the digest" "$DIGEST_TEXT" "Математика &lt;5.1&gt;"
expect_text_lacks "the digest does not leak raw angle brackets" "$DIGEST_TEXT" "Математика <5.1>"
expect_text_has "the digest is signed with the product name" "$DIGEST_TEXT" "hmwrk"
expect_eq "the digest was sent with parse_mode=HTML" "$(mock_parse_modes_to "$PARENT_CHAT")" "HTML"
expect_file_has "server log: the digest firing was recorded" "$LOG" '"kind":"digest"'
expect_file_has "server log: delivery is logged for the digest" "$LOG" '"msg":"notify: message delivered"'

# ---------------------------------------------------------------------------
# f) paused_until mutes the next digest
# ---------------------------------------------------------------------------

section "f) paused_until глушит ближайший дайджест"

say_as "$PARENT_KEY" "parent pauses the broadcasts for today" "$SCRATCH/pause.response.json" "$PARENT_PAUSE_TEXT"
expect_answer_has "the pause is stored" "$SCRATCH/pause.response.json" "до $TODAY_RU включительно"
expect_eq "paused_until is stored" "$(db_value "SELECT value FROM settings WHERE key = 'paused_until'")" "\"$TODAY\""

# A third digest window: the task is recreated and must fire (and be muted) inside it.
PAUSED_PARENT_COUNT="$(mock_count_to "$PARENT_CHAT")"
say_as "$PARENT_KEY" "parent moves the digest again" "$SCRATCH/digest-late.response.json" "$PARENT_DIGEST_LATE_TEXT"
expect_answer_has "the digest schedule was rebuilt again" \
  "$SCRATCH/digest-late.response.json" "Расписание дайджеста пересобрано"

if wait_log_line '"msg":"notify: broadcasts are paused, nothing is sent"' "$((DIGEST_LATE_WAIT + 150))"; then
  ok "the digest fired in the new window and was skipped as paused"
else
  fail "the paused digest did not fire within $((DIGEST_LATE_WAIT + 150))s"
fi
sleep 2
expect_eq "no message reached the parent chat while paused" \
  "$(mock_count_to "$PARENT_CHAT")" "$PAUSED_PARENT_COUNT"

# ---------------------------------------------------------------------------
# Shutdown and log hygiene
# ---------------------------------------------------------------------------

section "shutdown and logs"

stop_core "after the M3 cycle"

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
  ok "no warnings besides the expected faux hook notice"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

printf '\n'
if [ "$FAIL_COUNT" -ne 0 ]; then
  say "M3 verification FAILED: $FAIL_COUNT failed, $PASS_COUNT passed"
  exit 1
fi
say "M3 verification passed: $PASS_COUNT checks, 0 failed"
