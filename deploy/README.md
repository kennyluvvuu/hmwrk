# Деплой hmwrk (Docker Compose)

Стек: `open-webui` (единственный порт наружу — 3000) + ядро `hmwrk`
(8787 виден только внутри сети compose). Контракт — [docs/SPEC.md §9](../docs/SPEC.md).

## Первый запуск

```bash
cd deploy
cp .env.example .env      # заполнить ключи; что это — в комментариях внутри
cp ../models.example.json models.json && $EDITOR models.json   # реальные model id
docker compose build
docker compose run --rm -v "$PWD/models.json:/tmp/models.json:ro" --entrypoint sh hmwrk \
  -c 'mkdir -p /data && cp /tmp/models.json /data/models.json'
docker compose up -d
```

`models.json` не входит в образ (это конфиг): команда `run` кладёт его в volume
`hmwrk-data` по пути `/data/models.json`, откуда его читает ядро. Дальше хватает
`docker compose up -d`; после правок кода/зависимостей — `docker compose up -d --build`.

OpenWebUI: http://&lt;хост&gt;:3000 (первый вход создаёт админа). OpenAI-соединение к
ядру настраивается в UI, не в compose: Admin → Settings → Connections →
URL `http://hmwrk:8787/v1`, ключ — `HMWRK_PARENT_KEY` или `HMWRK_CHILD_KEY`.
Пошагово — гайд `docs/setup-openwebui.md` (G1).

## Где данные

| Volume | В контейнере | Что внутри |
|---|---|---|
| `hmwrk-data` | `/data` | SQLite (`hmwrk.sqlite*`), фото (`photos/`), `models.json` |
| `open-webui-data` | `/app/backend/data` | аккаунты, чаты, настройки, подключения |

`docker compose down` volume сохраняет; `docker compose down -v` удаляет (потеря данных).

## Логи и состояние

```bash
docker compose logs -f hmwrk        # ядро
docker compose logs -f open-webui   # UI
docker compose ps                   # статус + healthcheck
```

Healthcheck ядра — `GET /healthz` внутри контейнера; `open-webui` стартует
только после того, как ядро стало healthy (`depends_on`).

## Обновление

```bash
docker compose pull             # новая версия open-webui по закреплённому тегу
docker compose up -d --build    # пересобрать hmwrk, перезапустить оба
```

Тег OpenWebUI осознанно закреплён на релиз (`v0.13.4`), а не на плавающий
`:main`/`:latest`. Обновление = правка тега в `docker-compose.yml` + чтение
release notes. Данные в volume обновление переживают. Рестарт сервера безопасен:
durable-задачи продолжаются с последнего checkpoint.

## Замечания

- Порт ядра наружу не публикуется (спека): извне доступен только UI.
- `.env` в git не попадает; реальные ключи — только на сервере.
- `TZ` (в compose по умолчанию `Europe/Moscow`) задаёт локальное время
  напоминаний и дайджеста.
