# Отчёт верификации M1 (веха 1, задача V1)

Дата: 24.11.2026. Ветка задачи: `thr_4s6p4gj3f7-1` (worktree от `main`), коммит: см. `git log -1` —
`test(e2e): M1 skeleton verification script and fixes (V1)`.
Окружение прогона: macOS, Node v26.13.1, npm 11.20.0, `tsx` из devDependencies.
Скрипт: `scripts/verify-m1.sh` (bash, `set -euo pipefail`, запускается из любого каталога).

## 1. Итог

| Проверка | Команда | Результат |
|---|---|---|
| E2E-скелет | `bash scripts/verify-m1.sh` | **exit 0, 27 проверок, 0 провалов** |
| Типы | `npm run typecheck` | зелёно |
| Юнит/интеграционные тесты | `npm test` | 20 файлов, **230 тестов**, зелёно |

Скрипт поднимает **реальное ядро** (`node --import tsx src/index.ts`, не `npm start`) на временном
`DATA_DIR` внутри `$TMPDIR`, с фейковыми `HMWRK_PARENT_KEY`/`HMWRK_CHILD_KEY`, свободным портом
loopback и `models.json` с id, подтверждёнными R1 K8 (`qwen/qwen3.6-27b`,
`deepseek-v4-1-flash-1017`), поэтому в логах нет предупреждения каталога моделей.
Артефакты прогона (логи, тела ответов, SQLite) удаляются при успехе; при провале — сохраняются,
`KEEP_ARTIFACTS=1` оставляет их и при успехе.

## 2. Что именно проверяется

1. `GET /healthz` → 200, тело `{"status":"ok"}`.
2. `GET /v1/models` с ключом parent → ровно один объект `model` с `id: "hmwrk"`, `object: "list"`.
3. Авторизация: без заголовка → 401 `missing_credentials`; неизвестный Bearer → 401
   `invalid_credentials`; тело ошибки в форме OpenAI (`error.type`, `error.code`, `error.message`).
4. `POST /v1/chat/completions` (`stream: false`, ключ parent) → 200, `object: chat.completion`,
   `id: chatcmpl-…`, `model: hmwrk`, `choices[0].message.role == "assistant"`,
   `finish_reason: "stop"`, `usage.total_tokens` — число, **текст ответа дословно равен вопросу**
   (echo, K6).
5. `POST /v1/chat/completions` (`stream: true`, ключ child) → 200,
   `content-type: text/event-stream`; SSE-последовательность: первый чанк — только role-delta
   (`delta.role == "assistant"`, без content, `finish_reason: null`), затем content-дельты,
   последний чанк — пустая delta с `finish_reason: "stop"` (+ usage), затем `data: [DONE]`;
   склейка content-дельт равна вопросу; у всех чанков один `id`, нет чанков с `error`, лишних
   (не `data: …`) строк нет.
6. СТОП-тест: после запросов — `SIGTERM` (graceful exit 0, в логе `hmwrk stopped`), затем
   перезапуск на том же `DATA_DIR` и повторный запрос того же пользователя (parent):
   - id беседы в debug-логе `chat completion` до и после рестарта **совпадает**;
   - parent и child получают **разные** беседы;
   - `sqlite3 … "select count(*) from pi_conversations"` = **2 до и 2 после** рестарта
     (новой беседы для известного пользователя не создаётся).
7. Гигиена логов: ни одной записи `"level":"error"`; предупреждения — только ожидаемые
   `request rejected` от двух 401-проверок; при boot зафиксированы `agent extension installed`
   (`hmwrk`) и `role resolver configured` (`static-keys`, т.к. `users` нет — M1).

## 3. Реальные выводы (сокращённо)

```
$ bash scripts/verify-m1.sh
verify-m1: port=60513
== boot (DATA_DIR=$TMPDIR/hmwrk-m1.XXXXXX/data) ==
  ok   core booted and /healthz is 200
  ok   /healthz body is {status:ok}
== GET /v1/models ==
  ok   /v1/models lists exactly one model, hmwrk
== auth ==
  ok   no Authorization header → 401
  ok   unknown API key → 401
== POST /v1/chat/completions (stream=false, parent) ==
  ok   stream=false body is a valid chat.completion that echoes the prompt
== POST /v1/chat/completions (stream=true, child) ==
  ok   stream=true → content-type: text/event-stream
  ok   SSE frames: role delta, content deltas, finish_reason chunk, [DONE]
== conversations before restart ==
  ok   parent request logged conversation id 3
  ok   child request logged a different conversation id 11
  ok   SIGTERM → graceful exit 0 (before restart)
  ok   SQLite holds exactly 2 conversations after two role keys
== restart on the same DATA_DIR ==
  ok   the parent resumed conversation 3 (persisted across restart)
  ok   SQLite still holds 2 conversations (no duplicate for a known user)
== logs ==
  ok   the hmwrk agent extension was installed at boot
  ok   role resolver runs in static-keys mode without a users directory (M1)
  ok   no error-level log records
  ok   no warnings besides the expected authentication rejections
M1 verification passed: 27 checks, 0 failed
```

Тела ответов:

```json
{"object":"list","data":[{"id":"hmwrk","object":"model","created":1795530627,"owned_by":"hmwrk"}]}

{"id":"chatcmpl-285c6b8b-…","object":"chat.completion","created":1795530628,"model":"hmwrk",
 "choices":[{"index":0,"message":{"role":"assistant","content":"привет, это родитель: проверка echo"},
 "finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}
```

SSE (начало и конец; каждая строка — `data: <json>`, чанки разделены пустой строкой):

```
data: {"id":"chatcmpl-4eb42109-…","object":"chat.completion.chunk","model":"hmwrk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"…","delta":{"content":"привет, это ребёнок: про"},"finish_reason":null}

data: {"…","delta":{"content":"верка SSE-стрима"},"finish_reason":null}

data: {"…","delta":{},"finish_reason":"stop"},"usage":{…}}

data: [DONE]
```

Логи (по одному процессу до и после рестарта):

```
{"level":"info","msg":"agent extension installed","extensions":["hmwrk"]}
{"level":"info","msg":"role resolver configured","mode":"static-keys"}
{"level":"info","msg":"hmwrk listening on :60513"}
{"level":"debug","msg":"chat completion","userId":"key:parent","conversationId":3,"stream":false}
{"level":"debug","msg":"chat completion","userId":"key:child","conversationId":11,"stream":true}
{"level":"info","msg":"received SIGTERM, shutting down"}
{"level":"info","msg":"hmwrk stopped"}
--- после рестарта ---
{"level":"debug","msg":"chat completion","userId":"key:parent","conversationId":3,"stream":false}
{"level":"info","msg":"hmwrk stopped"}
```

```
$ sqlite3 "$DATA_DIR/hmwrk.sqlite" "select count(*) from pi_conversations;"
2
```

Схема в том же файле — `pi_*` (durable) рядом с будущими доменными таблицами (K2): `pi_conversations`,
`pi_entries`, `pi_submissions`, `pi_documents`, `pi_tasks`, …

## 4. Найденные и починенные швы

Ручной smoke-прогон до правок показал, что контракты S1/S2/A1/T2 в целом сходятся: сборка `Core`
в `src/index.ts`, ленивый `openHarness`, миграции SQLite, маппинг OpenAI и SSH-фрейминг работали
сразу. Починено два реальных шва и одна устаревшая документация:

| Файл | Что было | Что сделано |
|---|---|---|
| `src/index.ts` | A1-расширение `hmwrk` (промпт-секция роли/даты, будущие инструменты) **нигде не устанавливалось при boot** — код жил только в тестах, registry оставался пустым. | После `openHarness`/`resume` boot собирает `buildAgentExtensions({ deps: { actors: core.actors, models } })` и ставит их через `installExtensions(core, …)` (K1/K7: фабрика читает `ActorDirectory` открытого ядра). В лог — `agent extension installed`. Это точка сборки M2: инструменты придут в тот же factory. |
| `src/index.ts` | Комментарий «S1 implements `openHarness`; until it lands, boot fails loudly» — S1 давно слит. | Комментарий приведён к факту: фасад S1, неудачное открытие прерывает boot. |
| `src/agent/extension.ts` | JSDoc утверждал, что контрактный ключ секции — `"hmwrk.role-and-date"` с точкой, и просил оркестратора починить контракт; по журналу W3 контракт уже `hmwrk-role-and-date`. | Комментарий исправлен: ключ уже валиден, `AGENT_SECTION_KEY_INSTALLED` остаётся единственной точкой нормализации (на случай будущего ключа с точкой). |
| `scripts/verify-m1.sh` | Не существовал. | Новый E2E-скрипт (27 проверок), см. §2. |

Других правок в `src/**` не потребовалось.

## 5. Известные ограничения (и что осталось на ручной чек-лист)

- **OpenWebUI-заголовки не проверяются здесь.** В прогоне `users`-справочника нет, резолвер
  штатно деградирует в `static-keys`; гибридный режим (`x-openwebui-user-*` → роль из таблицы
  `users`) проверяется только на живом OpenWebUI по чек-листу G1 (`docs/verification/openwebui-checklist.md`).
  Это единственный незакрытый пункт риска №3 спеки — ручной шаг пользователя.
- **Docker/compose не поднимались** (в песочнице нет docker): `deploy/Dockerfile` и
  `docker-compose.yml` проверяются на сервере пользователя по тому же чек-листу G1; скрипт V1
  проверяет процесс, который запускает и контейнер.
- **Echo без идемпотентности** (K6): повтор того же HTTP-запроса создаёт ещё одну пару
  `pi.user`/`pi.assistant`; `requestId` принимается, но не дедуплицируется — снимается в M2,
  когда запросы пойдут через `submitUserInput`.
- **Промпт-секция агента в M1 не рендерится в runtime**: echo не вызывает модель, поэтому
  секция роли/даты выполняется только в юнит-тестах A1; в M2 её вызовет первый реальный run.
  Гарантия M1 — расширение установлено в registry при boot (валидатор registry его принял).
- **`shutdown()` из `src/durable` не используется**: `src/index.ts` реализует эквивалент
  (закрыть HTTP → `core.close()`, жёсткий выход через 10 с). Поведение проверено: SIGTERM →
  exit 0 и `hmwrk stopped`; унификация — при следующей правке boot.
- `models.example.json` намеренно оставляет placeholder-id: реальный деплой до правки
  `models.json` получит один warn `model slots are not in the pi-ai catalogue` (не ошибка,
  M1 модель не зовёт). Скрипт пишет свой `models.json` с id из R1 K8.
- Вне M1 по плану: картинки/фото (M3/P1), usage- и cost-учёт (K12/M3), доменные инструменты (M2).
- `sqlite3` в скрипте опционален: без него проверка персистентности опирается на id беседы в
  логах (и на `node:sqlite`, если доступен).

## 6. Воспроизведение

```bash
npm ci
npm run typecheck && npm test
bash scripts/verify-m1.sh          # exit 0 = зелёно
KEEP_ARTIFACTS=1 bash scripts/verify-m1.sh   # оставить логи/SQLite для разбора
```

Требования: Node ≥ 22, `curl`; `sqlite3` опционален. Временные файлы — только в `$TMPDIR`.
