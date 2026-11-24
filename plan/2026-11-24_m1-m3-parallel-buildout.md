# hmwrk — план сборки M1–M3 субагентами

Дата: 24.11.2026. Оркестратор: этот тред. Спека: [docs/SPEC.md](../docs/SPEC.md) (v0.1), решения ADR 0001–0004.
План покрывает вехи 1–3 из разд. 12 спецификации. Веха 4 (парсер журнала, статистика) — вне этого плана.

## 0. Роли и механика оркестрации

- **Оркестратор (этот тред)**: держит план, пишет брифы, спавнит субагентов, мержит их ветки, гоняет интеграцию, ведёт этот документ. Код и исследования руками не пишет.
- **Субагент** — один на задачу, Dev → одна задача = один тред:

  ```
  bb thread spawn \
    --prompt-file <бриф> \
    --provider pi --model mistral/deepseek-v4-1-flash-1017 --reasoning-level high \
    --new-environment worktree --base-branch refs/heads/main \
    --permission-mode auto --parent-self --parent-notifications auto --json
  ```

- **Изоляция**: каждая задача работает в своём worktree на своей ветке от `main`. Параллельность — до 8 потоков на хосте (проверено: лимит 8).
- **Разделение файлов**: задачи одной волны не пересекаются по файлам (см. «Файлы» в карточках), конфликты при мерже исключены декомпозицией; контрактные модули пишутся раньше волн реализации.
- **Мерж**: субагент коммитит у себя (Conventional Commits, EN) и отчитывается; оркестратор в checkout гоняет `npm run typecheck && npm test`, мержит в `main`. Откат = удаление ветки.
- **Брифы** живут вне репо (`$TMPDIR`), ссылаются на spec/ADR/R1-заметки и на ID задачи из этого плана.
- **Языки**: код и идентификаторы EN; пользовательские доки RU; коммиты EN.
- **Антикоррупция спеки**: если реальность ломает спеку (риск №1/№3) — субагент возвращается с вопросом, оркестратор поднимает решение на уровень пользователя; мелкие дефолты фиксируются в коде.

## 1. Принципы декомпозиции

1. Волны (`W0…W8`) идут последовательно; внутри волны задачи параллельны.
2. Сначала контракты (типы, интерфейсы модулей), потом параллельная реализация против контрактов — иначе параллелизм даёт дрейф интерфейсов.
3. Каждая задача атомарна: один merge-блок, список файлов, тесты обязательны, самопроверка (typecheck+test) перед отчётом.
4. В середине кодовой задачи субагент может чинить только свои файлы; кросс-модульные фиксы — отдельные волны интеграции (V*/I*).

## 2. Веха 1 — Скелет (M1)

Цель: pi-durable harness + SQLite + пустой агент + OpenAI-совместимый `/v1/chat/completions` (echo) + роли + подключение OpenWebUI. Checkpoint риска №3 спеки.

### W0 — база (последовательная, 1 задача)

**T0 · Скаффолдинг** — S
- Вход: SPEC разд. 8 (структура кода), 9 (деплой).
- Сделать: `package.json` (type: module, npm scripts: `dev`, `start`, `typecheck`, `test`), `tsconfig.json` (strict), `.gitignore`, `vitest.config.ts`, заглушка `src/index.ts`, `README.md` (RU, краткий: как запустить). Установить и запинить: `@earendil-works/pi-durable@1.6.0`, `@earendil-works/pi-ai@1.6.0`, плюс их peer-зависимости тех же 1.6.x (chord, pi-schema), `hono`, `zod`; dev: `typescript`, `tsx`, `vitest`. Runtime: Node 22 + tsx (без сборки tsc-бинди, только typecheck).
- Файлы-владения: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `vitest.config.ts`, `src/index.ts`, `README.md`.
- Готовность: `npm ci && npm run typecheck && npm test` зелёные; lockfile в репо (нужен для npm ci в worktree-ах).

### W1 — исследования и домен (параллельно ×3, после T0)

**R1 · Верификация API pi-durable/pi-ai 1.6.0** — M
- Вход: `npm ci` в worktree; читать `node_modules/@earendil-works/pi-durable/README.md`, `dist/**.d.ts`, pi-ai аналогично. Tarball'ы запрещены к выдумыванию — только фактический установленный код.
- Выход: `docs/research/pi-api-notes.md` (RU) с ответами K1–K12 и сниппетами:
  - K1 точная сигнатура `Harness.open` (options: identity/settings/onReport/env).
  - K2 node-sqlite storage: можно ли шарить один файл с доменными таблицами (adapter+prefix) — или два файла; вердикт + сниппет.
  - K3 беседа-на-пользователя: createConversation(ownerless) + как найти/сохранить соответствие user→conversation после рестарта; паттерн.
  - K4 `submit/wait/requestId/entries` → корреляция HTTP-запрос → ответ в OpenAI-прокси.
  - K5 стриминг: фактическая форма частичного ответа run (watch `docs["pi.live"].generation.partial`) → конверсия в OpenAI SSE chunks; abort при disconnect клиента.
  - K6 echo для M1: faux-provider scripted echo vs прямой entry — вердикт + рабочий сниппет.
  - K7 инструменты: defineTool(parameters=JSON Schema через pi-schema) — как жить со spec-требованием «валидация аргументов zod»; вердикт (pi-schema vs zod→json-schema).
  - K8 провайдеры Groq/Mistral: фабрики, env-ключи, есть ли в каталоге нужные model id (Groq vision, Mistral deepseek); как задать модель не из каталога (custom provider/compat).
  - K9 defineTask: phases/sleepUntil/checkpoint/outcomes; шедулирование напоминаний по настройкам.
  - K10 картинки в контексте: как изображение доходит до модели/инструмента, лимиты vision Groq (pi-ai image input).
  - K11 graceful `close()`: что с pending задачами, поведение при SIGTERM.
  - K12 usage/cost snapshot (для дайджеста).
- Файлы-владения: `docs/research/pi-api-notes.md` (+ `docs/research/code-snippets/` при необходимости).
- Готовность: каждый K-пункт отвечает «как именно в 1.6.0», с указанием файла .d.ts, где это видно.

**T1 · Домен: типы, zod-схемы, интерфейсы репозиториев** — M
- Вход: SPEC разд. 4 (роли), 5.1–5.2 (состояния, таблицы), 5.5 (список инструментов), GLOSSARY.
- Сделать: `src/domain/` — `types.ts` (Assignment, AssignmentItem, CheckIn, Photo, Verification, VerificationFinding, User, Role, TgBinding, Settings, статусы из спеки), `schemas.ts` (zod для каждой сущности и для аргументов всех 9 инструментов), `repo.ts` (интерфейсы репозиториев + `src/domain/fakes.ts` — in-memory фейки для тестов), `settings.ts` (дефолты: reminder 19:00, digest 21:00, дедлайн завтра 20:00, parse «20:00 след. дня»),日期-утилиты `dates.ts`.
- Тесты: unit на схемы/парсинг дат/машину статусов (`active→in_review→done`, производный `overdue`).
- Файлы-владения: `src/domain/**`.
- Готовность: typecheck+test зелёные; никаких упоминаний БД кроме интерфейсов.

**T2 · Конфиг** — S
- Вход: SPEC разд. 7 (модели per-config), 8 (config/), 9.
- Сделать: `src/config/env.ts` (zod-схема env: PORT, DATA_DIR, GROQ_API_KEY, MISTRAL_API_KEY, TELEGRAM_BOT_TOKEN, HMWRK_PARENT_KEY, HMWRK_CHILD_KEY, LOG_LEVEL; `.env` загрузка), `src/config/models.ts` (загрузчик `models.json` — слоты read/verify/chat: provider+model id + валидация), `src/config/index.ts` (агрегация), `src/config/logger.ts` (простой leveled logger, без новых зависимостей). Заготовку `models.example.json` — дефолты из спеки (groq vision + mistral deepseek) с комментарием, что id могут поменяться.
- Тесты: env с отсутствующими необязательными переменными; валидный/невалидный models.json.
- Файлы-владения: `src/config/**`, `models.example.json`.
- Готовность: typecheck+test зелёные.

### W2 — контракты и деплой (параллельно ×2, после W1 merge)

**T3 · Внутренние контракты** — S
- Вход: R1 (K1–K6), SPEC разд. 8.
- Сделать: `src/contracts/harness.ts` — фасад над pi-durable: `Core.open(cfg)/close()/resume()/conversation(userId, role)/submitAndWatch(...)` (сигнатуры под фактический API из R1); `src/contracts/roles.ts` — `RoleResolver` (из заголовков/ключей → {role, userId}); `src/contracts/openai.ts` — типы ChatCompletion request/chunk + `mapToConversation*` сигнатуры; `src/contracts/agent.ts` — сборка extension/registry (для A1).
- Файлы-владения: `src/contracts/**`.
- Готовность: типы компилируются; JSDoc-комментарии ссылаются на ответы R1 по номерам K*.

**E1 · Деплой-каркас** — S
- Вход: SPEC разд. 9; env-переменные из T2.
- Сделать: `deploy/Dockerfile` (node:22-slim + tsx), `deploy/docker-compose.yml` (open-webui :3000 + hmwrk внутренний :8787, volumes: open-webui данные + `hmwrk-data`), `deploy/.env.example`, `.dockerignore`. Здоровье: hmwrk `/healthz`.
- Файлы-владения: `deploy/**`, `.dockerignore`.
- Готовность: конфиг вычитывается T2-схемой; без сборки образа (сборка — на стороне сервера юзера).

### W3 — реализация скелета (параллельно ×3, после W2 merge)

**S1 · Durable-обёртка** — M
- Вход: T3, R1 K1–K6, ADR 0002 (риск №1: пин версии + тонкая обёртка).
- Сделать: `src/durable/harness.ts` — реализация фасада поверх pi-durable (хранение: по вердикту R1 K2 — рекомендованный вариант шаринга файла либо два файла; идентичность приложения hmwrk; resume-on-boot; закрытие по SIGTERM), `src/durable/conversations.ts` — user→durable-беседа (по выводу R1 K3), тесты: открытие/закрытие/рестарт-продолжение на temp-sqlite, две беседы пользователей независимы, echo-прогон через выбранный R1K6 механизм.
- Файлы-владения: `src/durable/**` (+ тесты).
- Готовность: тесты зелёные, включая сценарий «kill → reopen → контекст жив» (в рамках одного тест-прогона: close+reopen).

**S2 · OpenAI-сервер** — M/L
- Вход: T3, R1 K4–K6, SPEC разд. 3, 6 (SSE обязателен).
- Сделать: `src/server/app.ts` (Hono): `POST /v1/chat/completions` (stream=true → SSE; stream=false → полный ответ; echo-агент из R1K6; маппинг по `src/contracts/openai.ts`), `GET /v1/models` (одна модель `hmwrk`), `GET /healthz`, auth-мiddleware (`RoleResolver`: статические ключи parent/child + чтение заголовков OpenWebUI-контекста, если настроены), `src/server/sse.ts` (writer chunks + abort на disconnect). `src/index.ts` — владение S2 (только S2 пишет его в этой волне).
- Файлы-владения: `src/server/**`, `src/index.ts`.
- Тесты: запрос/ответ echo без стрима и со стримом (парсинг SSE-чанков), 401 без ключа, разные ключи → разные пользователи/беседы.
- Готовность: тесты зелёные.

**A1 · Скелет агента** — S
- Вход: T3, R1 K7, SPEC разд. 5.5, 6 (системный промпт).
- Сделать: `src/agent/extension.ts` (extension `hmwrk`: section «роль и дата»); `src/agent/prompt.ts` (RU системный промпт: роли, формат дат, правила поведения пустого агента M1 — «я скелет, домен-инструменты не подключены»); подключение registry — точка сборки для M2.
- Файлы-владения: `src/agent/**`.
- Тесты: рендер section для parent/child.
- Готовность: typecheck+test зелёные.

### W4 — интеграция M1 (параллельно ×2, после W3 merge)

**V1 · E2E-прогон скелета** — M
- Вход: всё слитое, `deploy/`.
- Сделать: `scripts/verify-m1.sh` (запуск ядра → curl /healthz → /v1/models → chat без стрима → SSE-стрим с проверкой chunk-формата → рестарт процесса → повторный запрос того же пользователя: ответ echo + подтверждение персистентности беседы по логам/базе) и отчёт `docs/verification/m1-report.md` (RU, с реальным выводом прогонов). Мелкие фиксы — в пределах любых файлов (волна одиночная), коммиты.
- Готовность: скрипт зелёный на слитом main, отчёт заполнен.

**G1 · Гайд подключения OpenWebUI** — M
- Вход: S2 (auth), SPEC разд. 4 (механизм ролей), риск №3, ADR 0001/0004.
- Сделать: `docs/setup-openwebui.md` (RU): compose up → администрирование OpenWebUI → подключение OpenAI-API `hmwrk` (`http://hmwrk:8787/v1` без наружной публикации порта) → два аккаунта → что именно проверять в заголовках (цифры/имена заголовков для текущей версии OpenWebUI: перечислить, что ДОЛЖНО прийти — фиксируем фактом из лога hmwrk) → последовательность включения маппинга user→role → fallback-сценарий с двумя статическими ключами и группами; `docs/verification/openwebui-checklist.md`: пошаговый чек-лист для юзера (ручной шаг на его сервере), что приложить обратно в тред.
- Файлы-владения: `docs/setup-openwebui.md`, `docs/verification/openwebui-checklist.md`.
- Готовность: гайд проходим по шагам без кодовых погружений.

**Checkpoint M1 (ручной шаг юзера)**: поднять compose дома, подключить OpenWebUI, прогнать чек-лист → фиксируем механику ролей (риск №3 закрыт или включаем fallback). Спека обновляется заметкой в разд. 4.

## 3. Веха 2 — Цикл ДЗ (M2)

Брифы W5–W6 пишутся после checkpoint M1 (детали уточняются), разбивка фиксирована:

### W5 (параллельно ×3)
- **D2 · Репозитории** — M. Реализация интерфейсов T1 поверх SQLite (решение R1K2: общий файл с prefix или отдельный `data/hmwrk.sqlite`), миграции-при-старте, `src/store/**`, тесты на каждый репо.
- **A2 · Инструменты (9)** — L. `src/agent/tools/**` против интерфейсов T1 и контракта запуска durable-задачи (`src/contracts/tasks.ts`, входит в бриф D2-A2 — пишет A2): list_assignments, parse_screenshot (заглушка под W7), manual_add_assignment, submit_check_in, get_verdicts, approve_verification, dismiss_verification, get_settings, set_setting; гейтинг по роли; сообщение человеку при кривых аргументах. Фейковые репо в тестах.
- **V2 · Verify-конвейер** — L. `src/llm/**` (клиенты read/verify/chat из models.json через pi-ai, обёртки с таймаутами/ретраями) + `src/durable/tasks/verify.ts` (двухступенчато: прочтение фото → решение+сверка по пунктам, verdict-JSON по zod-схеме, `unclear` без угадывания, запись draft-верификации). Тесты на faux-провайдере.

### W6 (параллельно ×2)
- **I2 · Склейка M2** — M. Подключение инструментов в extension агента, системный промпт с кратким списком активных заданий, submit_check_in → старт verify-задачи, пересчёт вердикта при дополнении фото, фиксы по швам. Одиночная волна, право трогать любые файлы.
- **P2 · E2E цикла** — M. `scripts/verify-m2.sh` + отчёт: ручное добавление → список → отчёт (faux-фото) → черновой вердикт → утверждение → done; overdue-вывод. С faux-моделями; реальные ключи — опциональный smoke юзера.

## 4. Веха 3 — Скриншот-интэйк + Telegram (M3)

### W7 (параллельно ×3)
- **P1 · Photo-интэйк** — M. `src/media/**` (сохранение фото из сообщения OpenAI-API в `data/photos`, лимиты), инструмент `parse_screenshot` через read-модель (Groq vision) → структурированный черновик заданий → подтверждение родителем → создание заданий; отмена = ничего не создаётся (SPEC 5.3). Тесты на faux.
- **G1T · Telegram-клиент** — M. `src/telegram/**`: только sendMessage, bindings (chat_id из таблицы), шаблоны напоминания/дайджеста; тесты с mock-fetch.
- **N1 · Напоминание и дайджест** — L. `src/durable/tasks/reminder.ts`, `digest.ts`: спят до settings-времени (fake clock в тестах), собирают списки (что завтра / что просрочено / что ждёт утверждения / что от парсера на подтверждении), `paused_until` глушит. Перепланирование при смене настроек.

### W8 (одиночная)
- **I3 · Склейка M3 + финальный прогон** — M. Настройки из чата (set_setting с эффектом на рассылки), e2e-скрипт M3, отчёт, обновление README (RU: запуск, переменные, флоу).

## 5. Политика

- **Retry**: субагент вернулся с красными тестами → один повтор с доп. контекстом; второй провал → задача дробится оркестратором.
- **Внутризадачные решения** (имена файлов, алгоритмы внутри модуля) субагент принимает сам; решения уровня спеки (второй файл БД, замена zod→pi-schema) — в отчёт, оркестратор выносит юзеру только ломающие; мелкие фиксируются в коде сами.
- **Секреты**: только имена env-переменных; значения не коммитятся; `.env.example` без значений.
- **Definition of done вехи**: все ответы K* подтверждены кодом, e2e-скрипт зелёный, отчёт заполнен; для M1 — плюс пройденный юзером openwebui-checklist.

## 6. Открытые точки, закрываемые планом

- Спека говорит «SQLite-файл один» (5.2) — если R1K2 скажет, что шаринг файла с pi-durable неудобен, осознанно берём два файла (`data/durable.sqlite` + `data/hmwrk.sqlite`), фиксируем правкой спеки. Оркестратор решает по выводу R1, юзера оповещаем.
- Спека требует zod для аргументов инструментов (5.5) — если pi-durable ест только JSON Schema нативно, ставим pi-schema (та же семантика, меньше слоёв) и правим строку спеки. Решение после R1K7.
- Пересечение: `parse_screenshot` в A2 делается заглушкой, полная реализация в P1 (W7) — чтобы M2 не тянул vision.

## 7. Журнал решений оркестратора

- **30.11 W1 (по отчёту T1)**: все спорные дефолты T1 подтверждаю: `dismiss → active` (отчёт сохраняется, ребёнок может дополнить/пересдать); `listPending` = последний draft на отчёт; `paused_until` включительно до конца суток; `get_settings` только родителю (по таблице §4); TZ-переменная нужна в compose (учтёт E1/D2). Дополнительные поля сверх §5.2 (`updated_at`, `position`, `checkins.comment`, `photos.kind: checkin|screenshot`, `verifications.decided_by_user_id`) — принимаю (§5.2 был «сокращённо», флоу требует). D2 закладывает их в миграции; N1 использует `list({hasCheckIn:false})` (SQL NOT EXISTS — ок).
- **W0 (по отчёту T0)**: typescript остаётся на ^5.9 (не TS7); @types/node отдельно не ставим (транзитивного хватает; если S1/S2 понадобится — вынесут вопрос).
- **W1 (по отчёту R1)**: K2 — спека §5.2 «SQLite-файл один» подтверждена: `openNodeSqliteDatabase(path)` → `SqliteStorage.open(db, {prefix:"pi_"})`, доменные таблицы рядом с `pi_*`; второй файл не заводим. K6 — echo в M1 делаем прямой записью `pi.user`+`pi.assistant` в одном commit (без модели); faux остаётся для тестов агентской петли (M2). K7 — схемы инструментов авторствуем на zod, наружу отдаём `z.toJSONSchema()`, фактическая валидация — pi-механика pi-durable (спека §5.5 выполняется на уровне авторства). K5 — стриминг черпаем из `docs["pi.live"].generation.message`, `partialIntervalMs: 30–50`. K8 — кандидаты read-слота: Groq `qwen/qwen3.6-27b`/`qwen3.8-27b` (vision); verify/chat: Mistral `deepseek-v4-1-flash-1017`. readOnly-режим не используем; соответствие user→conversation храним в session-документе атомарно с созданием беседы; `settled.answer` опционален — хелпер в S1; usage без временного разреза — свой снапшот в M3 (дайджест не пострадает, статистика — веха 4).
- **W3 (по отчётам S1/S2/A1)**: S1 легально уточнил контракты (openHarness → ленивый делегат в src/durable, +models/logger тестовые швы) — принято. Расхождение A1 по section key закрыто правкой контракта: `AGENT_SECTION_KEY = "hmwrk-role-and-date"` (валидатор registry `/^[a-z][a-z0-9_-]*$/` запрещает точки); M2 об-turn секции через `AGENT_SECTION_KEY_INSTALLED`. Сводка активных заданий в промпте (SPEC §6) в M2 добавится в `AgentPromptContext` (сейчас — опциональный 3-й аргумент рендера, контракт не трогали). Известные ограничения M1: echo без requestId-идемпотентности (дубли пар при ретраях OpenWebUI — снимается в M2), дата в систем-секции сбрасывает prompt-cache раз в сутки (требование SPEC §6, принято), заголовки OpenWebUI включаются после checkpoint M1 (гибридный режим уже в auth.ts).
- **W4 (по отчётам V1/G1)**: M1 проверен end-to-end — `scripts/verify-m1.sh` 27/27 зелёные (echo без стрима/со стримом, роли, 401, SIGTERM→персистентность бесед, count == 2). V1 починил сборку расширения агента в boot (A1-секция раньше не ставилась в runtime). Риск №3: статические ключи работают из коробки; header-режим (а) требует: users-таблицу (D2) + wiring в bootstrap (I2) + env ENABLE_FORWARD_USER_INFO_HEADERS в OpenWebUI (override-compose, гайд G1). Найденные G1 дыры кладу в брифы M2: I2 — лог имён X-OpenWebUI-заголовков на debug + wiring users-directory в bootstrap; E1-follow-up (после checkpoint) — закрепить override env в compose. Fallback-схема OpenWebUI: per-role ключи требуют Prefix ID (parent/child), базовая модель — запись в Settings→Models с read-доступом группе.
- **W5–W6 (по отчётам D2/A2/V2/I2/P2)**: A2 разрешил ролевой гейтинг через ActorDirectory per-call (роль не приходит из промпта) — принято. V2: schema-constrained completion у pi-ai 1.6.0 только для tools — verify-модель решает через строгий промпт + zod-парсинг + 1 повтор + degraded `unclear` (SPEC §5.4 соблюдён). Дубли verify защищены latestForCheckIn (constraint на уровне репо — вопрос D2-последующим миграциям). I2: echo удалён в пользу generation; фото сохраняются сервером (kind по роли в P1); users-directory подключён к RoleResolver (hybrid-режим); debug-лог имён X-OpenWebUI-заголовков. P2: 94/94, X-Request-Id ретраи идемпотентны. Известный шов (P2): полностью одинаковые подряд идущие вопросы дедуплицируются фолбэк-хэшем — в I3 фолбэк дополнить счётчиком entries беседы (идемпотентность ретрая сохраняется, повтор после новых событий — пересчитывается).
- **W7 (по отчётам P1/G1T/N1)**: принимаю решения — (1) окно напоминания расширяем до конца следующих локальных суток (не «now+24h»): по SPEC §5.6 смысл — «завтра сдать», а дефолт `дедлайн завтра 20:00` при напоминании 19:00 должен попадать в вечернее напоминание НАКАНУНЕ; правка одной константы + тест уходит в I3; (2) секция «черновики парсера» в дайджесте остаётся прокси-признаком N1 (активное задание с source=screenshot без items) — durable-черновики не заводим (таблиц нет по SPEC 5.3); (3) напоминание/дайджест — вечные sleeping-задачи, ensureScheduled идемпотентен на boot; при set_setting новый момент применяется со следующего цикла (мгновенность через abort+ensure в I3 если дёшево). G1T-найдка о HTML parse_mode и bind-скрипте — в docs/telegram-setup.md; TELEGRAM_API_URL override для e2e есть.
- **W8 (финал, отчёт I3)**: M3 собран и проверен — три e2e зелёные (`verify-m1.sh` 27/27, `verify-m2.sh` 94/94, `verify-m3.sh` 71/71, суммарно ~6 мин на m3-прогон с реальным расписанием на mock-Telegram), typecheck + **526 тестов** зелёные в main. Фактическая модель расписаний: вечные sleeping-задачи `hmwrk.reminder`/`hmwrk.digest`, `ensureScheduled()` идемпотентен на boot, смена `reminder_time`/`digest_time` из чата применяет новый момент немедленно (переприоритизация в инструментальном вызове), `paused_until` глушит. Окно напоминаний — до конца следующих суток (решение W7). README — финальный (RU). **Вехи 1–3 плана выполнены целиком; веха 4 (парсер журнала, статистика) — сознательно вне скоупа.**

## 8. Финальное состояние (M1–M3, main)

- Ядро: pi-durable 1.6.0 (SQLite один файл, prefix `pi_`), pi-ai (Groq vision read → Mistral DeepSeek verify/chat), 9 инструментов с ролевым гейтингом через ActorDirectory, verify как durable-задача (unclear-честность), интэйк скриншотов (debug-grade), Telegram-рассылки (напоминание/дайджест/bind-скрипт), OpenAI-совместимый SSE-сервер для OpenWebUI, hybrid-роли (заголовки при наличии users-таблицы, иначе статические ключи).
- Проверки: `npm run typecheck`, `npm test` (526), `scripts/verify-m1.sh`, `verify-m2.sh`, `verify-m3.sh`.
- Ручные шаги юзера: живые ключи Groq/Mistral + реальный `models.json`; токен Telegram + bind-скрипт; поднять compose (deploy/) и пройти `docs/verification/openwebui-checklist.md` (закрывает риск №3 — заголовки x-openwebui-*); smoke с настоящим фото тетради по `docs/verification/m2-report.md` §5.
