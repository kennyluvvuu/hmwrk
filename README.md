# hmwrk

Домашний помощник по домашке: OpenAI-совместимый бэкенд для OpenWebUI на агентном ядре
`@earendil-works/pi-durable` (SQLite, durable-задачи, доступ к моделям через `@earendil-works/pi-ai`).

**Статус:** M2 — живой цикл ДЗ. `/v1/chat/completions` обслуживает настоящий агент с девятью
домен-инструментами, отчёт с фото запускает durable-задачу проверки, вердикт утверждает родитель.

## Запуск

```bash
npm ci          # установка зависимостей по lockfile
npm run typecheck
npm test        # vitest
npm run dev     # tsx watch src/index.ts
npm start       # tsx src/index.ts (без watch)
bash scripts/verify-m1.sh   # e2e проверка M1 (echo-путь, без ключей)
```

Требуется Node >= 22. Сборки через `tsc` нет: рантайм всегда `tsx`, `tsc` — только для проверки типов.

## Переменные окружения

Обязательные: `HMWRK_PARENT_KEY`, `HMWRK_CHILD_KEY` (два статических ключа — fallback-механизм ролей).
Остальные — по [docs/SPEC.md](docs/SPEC.md) разд. 9 и `src/config/env.ts`.

Специальные режимы:

- `HMWRK_ECHO=1` — ответ без модели: запрос возвращается эхом (путь M1, которым живёт
  `scripts/verify-m1.sh`). По умолчанию выключен: эндпоинт отвечает агентом.
- `HMWRK_FAUX_LLM=1` — вместо groq/mistral ставится faux-провайдер pi-ai; скрипт ответов задаётся
  файлом `HMWRK_FAUX_SCRIPT` (JSON, формат — в шапке `src/faux.ts`). Полный цикл без API-ключей.

Роли: при наличии строки в таблице `users` роль берётся из заголовка `X-OpenWebUI-User-Id`
(режим `hybrid`); без заголовка работает статический ключ. На `LOG_LEVEL=debug` в лог пишутся
**имена** пришедших `X-OpenWebUI-*`-заголовков (без значений) — это то, что читает чек-лист
[docs/verification/openwebui-checklist.md](docs/verification/openwebui-checklist.md).

## Документация

- [docs/SPEC.md](docs/SPEC.md) — спецификация (архитектура, домен, кодовая структура, деплой)
- [docs/adr/](docs/adr/) — архитектурные решения
- [plan/2026-11-24_m1-m3-parallel-buildout.md](plan/2026-11-24_m1-m3-parallel-buildout.md) — план сборки M1–M3
- [GLOSSARY.md](GLOSSARY.md) — глоссарий домена
