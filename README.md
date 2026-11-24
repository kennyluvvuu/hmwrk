# hmwrk

Домашний помощник по домашке: OpenAI-совместимый бэкенд для OpenWebUI на агентном ядре
`@earendil-works/pi-durable` (SQLite, durable-задачи, доступ к моделям через `@earendil-works/pi-ai`).

**Статус:** M1 skeleton в разработке (сейчас — только каркас проекта).

## Запуск

```bash
npm ci          # установка зависимостей по lockfile
npm run typecheck
npm test        # vitest
npm run dev     # tsx watch src/index.ts
npm start       # tsx src/index.ts (без watch)
```

Требуется Node >= 22. Сборки через `tsc` нет: рантайм всегда `tsx`, `tsc` — только для проверки типов.

## Документация

- [docs/SPEC.md](docs/SPEC.md) — спецификация (архитектура, домен, кодовая структура, деплой)
- [docs/adr/](docs/adr/) — архитектурные решения
- [plan/2026-11-24_m1-m3-parallel-buildout.md](plan/2026-11-24_m1-m3-parallel-buildout.md) — план сборки M1–M3
- [GLOSSARY.md](GLOSSARY.md) — глоссарий домена
