# hmwrk

Домашний помощник по домашке для семьи: OpenAI-совместимый бэкенд для OpenWebUI на агентном ядре
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) (SQLite,
durable-задачи) и моделях через `@earendil-works/pi-ai`.

**Статус: M3.** Родитель ставит задания (руками, скриншотом дневника), ребёнок отчитывается фото,
модель проверяет и готовит вердикт, родитель утверждает. Плюс Telegram-рассылки по расписанию:
вечернее напоминание ребёнку и итоговый дайджест родителю — время и пауза меняются прямо из чата.

- спецификация: [docs/SPEC.md](docs/SPEC.md), решения — [docs/adr/](docs/adr/), глоссарий — [GLOSSARY.md](GLOSSARY.md)
- что уже проверено: [docs/verification/](docs/verification/) (отчёты M1, M2, M3)

## Быстрый старт (локально)

Нужен Node >= 22 (проверено на 26.x). Сборки нет: рантайм — `tsx`, `tsc` только для проверки типов.

```bash
npm ci
npm run typecheck && npm test     # типы и юнит/интеграционные тесты (без ключей и сети)

cp models.example.json data/models.json   # и заменить modelId на реальные id из каталога pi-ai
mkdir -p data
cat > .env <<'ENV'
DATA_DIR=./data
HMWRK_PARENT_KEY=длинный-случайный-ключ-родителя
HMWRK_CHILD_KEY=длинный-случайный-ключ-ребёнка
GROQ_API_KEY=…
MISTRAL_API_KEY=…
TELEGRAM_BOT_TOKEN=…        # необязательно: без него рассылки просто не планируются
ENV

npm start        # http://127.0.0.1:8787 — OpenAI-совместимый /v1 + /healthz
```

`npm run dev` — то же самое с `tsx watch`. Сборки в `dist/` нет.

Данные: `DATA_DIR` (по умолчанию `./data`) — один SQLite-файл `hmwrk.sqlite` (durable-таблицы
`pi_*` и доменные рядом), `photos/` с картинками отчётов и скриншотов, `models.json`.

### Подключение из OpenWebUI

1. `docker compose up -d` в [deploy/](deploy/) или локальный `npm start`;
2. OpenWebUI → Settings → Connections → OpenAI API, base URL `http://<хост>:8787/v1`, ключ —
   `HMWRK_PARENT_KEY` (родитель) / `HMWRK_CHILD_KEY` (ребёнок), модель `hmwrk`;
3. подробно, с ролями через заголовки OpenWebUI: [docs/setup-openwebui.md](docs/setup-openwebui.md).

Можно и без OpenWebUI — обычным `curl` (см. примеры в [docs/verification/m2-report.md](docs/verification/m2-report.md)).

## Переменные окружения

Единственный источник — [`src/config/env.ts`](src/config/env.ts). `.env` в текущем каталоге читается
автоматически, переменные процесса важнее файла, пустое значение (`KEY=`) равно «не задано».

| Переменная | Обязательна | По умолчанию | Назначение |
|---|---|---|---|
| `PORT` | нет | `8787` | порт HTTP-сервера |
| `DATA_DIR` | нет | `./data` | каталог данных (SQLite, фото, `models.json`) |
| `LOG_LEVEL` | нет | `info` | `debug` / `info` / `warn` / `error` (JSON-логи) |
| `HMWRK_PARENT_KEY` | **да** | — | статический ключ роли «родитель» (fallback ADR 0004) |
| `HMWRK_CHILD_KEY` | **да** | — | статический ключ роли «ребёнок» |
| `GROQ_API_KEY` | для `read` | — | ключ Groq: чтение фото/скриншотов (слот `read`) |
| `MISTRAL_API_KEY` | для `verify`/`chat` | — | ключ Mistral: проверка и диалог |
| `MODELS_CONFIG` | нет | `<DATA_DIR>/models.json` | абсолютный путь к `models.json` |
| `TELEGRAM_BOT_TOKEN` | нет | — | токен бота @BotFather; без него рассылки не планируются |
| `TELEGRAM_API_URL` | нет | `https://api.telegram.org` | origin Bot API (только http(s); для e2e — локальный mock) |
| `HMWRK_ECHO` | нет | `0` | `1` — отвечать эхом без модели (путь M1, `verify-m1.sh`) |
| `HMWRK_FAUX_LLM` | нет | `0` | `1` — вместо groq/mistral скриптовый faux-провайдер (офлайн-цикл) |
| `HMWRK_FAUX_SCRIPT` | для faux | — | путь к JSON-сценарию faux-провайдера (формат — шапка [`src/faux.ts`](src/faux.ts)) |

`models.json` — три слота, id моделей живут только там (в коде их нет):

```json
{
  "read":   { "provider": "groq",    "modelId": "qwen/qwen3.6-27b" },
  "verify": { "provider": "mistral", "modelId": "deepseek-v4-1-flash-1017" },
  "chat":   { "provider": "mistral", "modelId": "deepseek-v4-1-flash-1017" }
}
```

## Telegram-рассылки

Расписание: `reminder_time` (напоминание ребёнку, по умолчанию 19:00) и `digest_time` (дайджест
родителю, 21:00), `paused_until` — пауза на каникулы. Меняются из чата словами («напоминай в 18:30»,
«поставь паузу до 5 января»): агент вызывает `set_setting`, и новое время применяется к ближайшему
окну, а не со следующего дня.

Бот только отправляет, поэтому chat_id задаётся один раз вручную:

1. узнать свой id — написать [@userinfobot](https://t.me/userinfobot) (`Id: 123456789`), нажать
   Start у своего бота (первым бот писать не может);
2. привязать чат к роли (**строки `users` для двух статических ключей создаются на старте**):

   ```bash
   node --import tsx scripts/bind-telegram.ts parent 123456789
   node --import tsx scripts/bind-telegram.ts child  987654321
   ```

   под compose: `docker compose exec hmwrk node --import tsx scripts/bind-telegram.ts parent 123456789`

Токен, коды ошибок Bot API (`400 can't parse entities`, `403 bot was blocked`, `429`) и тестовое
сообщение — [docs/telegram-setup.md](docs/telegram-setup.md).

## Прогоны без ключей (faux-LLM)

`HMWRK_FAUX_LLM=1` подменяет модели скриптовым faux-провайдером pi-ai: работает весь цикл
(агент, инструменты, durable-проверка), но ответы заранее записаны в JSON. Так гоняются e2e:

```bash
bash scripts/verify-m1.sh   # M1: echo-путь, роли, 401, SIGTERM, персистентность (ключи не нужны)
bash scripts/verify-m2.sh   # M2: задание → отчёт с фото → проверка → вердикт → просрочка (faux)
bash scripts/verify-m3.sh   # M3: Telegram-рассылки по расписанию, пауза, скриншот-интэйк (faux + mock Bot API)
```

`verify-m3.sh` поднимает настоящий сервер и локальный mock Telegram API (`scripts/mock-telegram.mjs`),
сам ставит `reminder_time`/`digest_time` на «через минуту» и ждёт реальные сообщения — прогон идёт
3–7 минут (расписание минутное). Все три скрипта читают/пишут только `$TMPDIR`; артефакты
сохраняются при провале, а с `KEEP_ARTIFACTS=1` — всегда.

## Docker / compose

`deploy/` — `Dockerfile` + `docker-compose.yml` (ядро + OpenWebUI), настройки в `deploy/.env`.
Коротко: скопировать `deploy/.env.example` → `deploy/.env`, прописать ключи/токен, `docker compose up -d`.
Подробности: [deploy/README.md](deploy/README.md), [docs/setup-openwebui.md](docs/setup-openwebui.md),
[docs/telegram-setup.md](docs/telegram-setup.md).

## Структура кода

```
src/config      env/.env, models.json, логгер (единственное место, где читается process.env)
src/durable     фасад pi-durable: открытие ядра, беседы, submit/watch/echo, tasks/
src/domain      типы, схемы zod, календарная математика, настройки, репозитории (контракты)
src/store       SQLite-реализация репозиториев, миграции, файлы фото
src/agent       промпт, расширение агента и девять инструментов (SPEC 5.5)
src/llm         клиенты read/verify/chat поверх pi-ai
src/server      Hono: /v1/chat/completions, /v1/models, /healthz, роли, SSE, приём фото
src/telegram    Bot API клиент, привязки чатов, шаблоны RU-сообщений
src/app.ts      сборка всего этого в правильном порядке (boot-контракт)
scripts/        bind-telegram.ts, verify-m1/m2/m3.sh, mock-telegram.mjs, faux-фикстуры
```
