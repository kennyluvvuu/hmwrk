# hmwrk — инструкции для агентов

hmwrk — сервис проверки домашних заданий: OpenWebUI (родитель/ребёнок) ходит в OpenAI-совместимое ядро на Node/TS поверх `@earendil-works/pi-durable`, проверка «прочтение фото (vision) → сверка (текстовая модель)», уведомления в Telegram, состояние в одном SQLite-файле.

Источник правды продукта: [docs/SPEC.md](docs/SPEC.md) (v0.1) · [GLOSSARY.md](GLOSSARY.md) · [docs/adr/](docs/adr/) (0001–0004, решения зафиксированы) · [docs/research/pi-api-notes.md](docs/research/pi-api-notes.md). Спорные решения прошлого — в журнале [плана сборки §7–8](plan/2026-11-24_m1-m3-parallel-buildout.md): **прежде чем менять статусы, роли, расписание или формат вердиктов — сверься с журналом и спекой**; новое архитектурное решение — новым ADR.

## Если ты оркестратор

orca-раунд любой масштаб: готовишь новую волну, спавнишь субагента, встретил «needs help» от дочернего треда, мержишь ветку в `main` — загрузи в промпт [plan/orchestrator.md](plan/orchestrator.md) (playbook) и работай по нему. Playbook = ролевой контракт (код и исследования — только субагентам), волны/брифы/гейт/журнал, шаблон спавна с проектными пинами и таблица известных permission-граблей.

## Команды

```bash
export npm_config_cache="$TMPDIR/npm-cache"   # ОБЯЗАТЕЛЬНО: в песочнице ~/.npm не пишется
npm ci && npm run typecheck && npm test       # стандартный гейт
node --import tsx src/index.ts                # запуск ядра (CLI `tsx` в песочнице падает на unix-сокете)
bash scripts/verify-m1.sh                     # e2e скелета (~1 мин)
bash scripts/verify-m2.sh                     # e2e цикла ДЗ на faux-LLM (~2 мин)
bash scripts/verify-m3.sh                     # e2e расписаний+Telegram на mock Bot API, реальные ожидания (~6 мин)
```

Тесты — vitest, лежат рядом с кодом (`*.test.ts`); HTTP тестируется через `app.request()` Hono (без listen).

## Памятка по песочнице (выстрадано на реальных падениях, см. orchestrator.md §7)

- Скратч — только `$TMPDIR` (не `/tmp`, не `../`): иначе permission-gate затыкает тебя и оркестратора.
- Не делать `cd node_modules/… && grep ../…` — питается как «вне проекта». Читай файлы напрямую: `node_modules/@earendil-works/…`, grep с путём от корня ворктри.
- Реальных API-ключей в тестах нет и не нужно: LLM — faux (`src/faux.ts`, `HMWRK_FAUX_LLM=1`), Telegram — `TELEGRAM_API_URL` на mock (`scripts/mock-telegram.mjs`).
- `data/`, `.env`, `*.sqlite*` — не коммитятся (уже в .gitignore). Секреты — только имена env-переменных.

## Карта кода

```
src/
  config/     env (zod), models.json-слоты read/verify/chat, logger
  domain/     типы, zod-схемы (сущности + аргументы 9 инструментов), репо-интерфейсы, fakes, машина статусов, даты
  contracts/  интерфейсы модулей (harness/roles/openai/agent/tasks/notify) — не трогай без ADR-повода
  durable/    ЕДИНСТВЕННОЕ место, знающее pi-durable (риск №1, ADR 0002): harness, беседы-на-пользователя, submit/стрим, shutdown; задачи: verify, reminder/digest
  store/      SQL-репозитории + миграции (один sqlite-файл с durable, доменные таблицы БЕЗ префикса `pi_`), файлы фото
  llm/        клиенты слотов над pi-ai: readImages/verifyHomework/chat, LlmError
  agent/      extension + системный промпт (RU) + 9 инструментов; роль — ТОЛЬКО через ActorDirectory per-call, не из промпта
  server/     OpenAI-протокол: маршруты, SSE, requestId-идемпотентность, роли (стат. ключи + x-openwebui-* hybrid), приём photos из сообщений
  telegram/   исходящий клиент (sendMessage only), templates, bindings
  app.ts      вся сборка wiring; index.ts — только process-обвязка
scripts/      verify-m1/2/3.sh, bind-telegram.ts, mock-telegram.mjs
deploy/       Dockerfile, docker-compose.yml (hmwrk наружу НЕ публикуется: OpenWebUI ходит по внутренней сети), .env.example
docs/         SPEC, ADR, research (pi-api-notes), setup-openwebui, telegram-setup, verification-отчёты
plan/         план волн + журнал решений (§7–8) + orchestrator.md (playbook оркестратора)
```

## Правила, которые дорого стоят

1. **Версии pi-* пинены на 1.6.0** (ADR 0002, риск №1 спеки): обновлять — только отдельной задачей с перечитыванием [pi-api-notes](docs/research/pi-api-notes.md) (K-ответы указывают, что ломается).
2. **Честность вердиктов**: verify-модель при сомнении отвечает `unclear`, при провале разбора — `degraded` «проверьте вручную». Никогда не угадывать пункты — это спека §5.4.
3. **Роль не спрашивается у модели**: гейтинг инструментов — `isToolAllowed` + ActorDirectory по conversationId.
4. **Инструменты не знают про SQL/Telegram напрямую**: только репо-интерфейсы и инъекции (спеки швов — в `src/contracts/`).
5. **Схемы аргументов** авторствуем на zod, наружу (в pi-durable) — `z.toJSONSchema()`; кривые аргументы → человекочитаемая RU-ошибка.
6. **Автосоздания заданий из скриншота нет**: `parse_screenshot` возвращает черновик; создание — только подтверждением родителя (`manual_add_assignment`) (спека §5.3).
7. Расписания — вечные sleeping-задачи в планировщике pi-durable (переживают рестарты); время — локальное (TZ процесса, в compose задан Europe/Moscow — править осознанно).

## Конвенции

- Код/идентификаторы/коммиты — EN (Conventional Commits, ID задачи в subject, например `feat(agent): … (A2)`); пользовательские тексты (промпты, ответы инструментов, доки) — RU.
- TypeScript strict, `type: module`, импорты с суффиксом `.js`.
- Новый функционал — с тестами; интеграционные правки — ориентироваться на `src/cycle.test.ts` (сквозной цикл на faux) и e2e-скрипты.
- До отчёта по задаче: `npm ci && npm run typecheck && npm test` обязаны быть зелёными, рабочее дерево чистое.
