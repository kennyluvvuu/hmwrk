# Подключение OpenWebUI к hmwrk

Гайд для M1: поднять стек, завести два аккаунта (родитель и ребёнок), подключить ядро
как OpenAI-совместимую модель и снять факт по заголовкам, которых не хватает для
автоматических ролей. Закрывает интеграционную точку спеки — риск №3 (SPEC §11) и
checkpoint из ADR 0004.

Что в M1 работает: `/v1/models`, `/v1/chat/completions` (echo — ядро возвращает твой же
текст), две статические роли (ключ = роль), durable-история беседы на ключ. Чего ещё нет:
инструментов домена, скриншотов, напоминаний, автоматического маппинга
OpenWebUI-пользователь → роль (о нём — шаг 6).

Все команды — из каталога `deploy/` репозитория, если не сказано иное.

---

## Шаг 0. Предпосылки

- Docker Engine + Compose v2 (`docker compose version`), порт `3000` на сервере свободен.
- Исходники репозитория на сервере: `git clone … && cd hmwrk`.
- Ничего наружу, кроме `3000`, публиковать не нужно: ядро живёт в сети compose под именем
  `hmwrk` и порт `8787` виден только контейнерам.

## Шаг 1. Конфиг: `.env` и ключи

```bash
cd deploy
cp .env.example .env
chmod 600 .env
```

Сгенерировать два ключа ролей и подставить в `.env` одной командой (Linux и macOS,
`-i.bak` работает в обоих):

```bash
sed -i.bak \
  -e "s|^HMWRK_PARENT_KEY=.*|HMWRK_PARENT_KEY=$(openssl rand -hex 32)|" \
  -e "s|^HMWRK_CHILD_KEY=.*|HMWRK_CHILD_KEY=$(openssl rand -hex 32)|" \
  -e "s|^LOG_LEVEL=.*|LOG_LEVEL=debug|" \
  .env && rm -f .env.bak
```

Проверить (должно быть по 64 символа и `debug`):

```bash
awk -F= '/^HMWRK_(PARENT|CHILD)_KEY=/{print $1, length($2)} /^LOG_LEVEL=/{print}' .env
```

Что за переменные (источник истины — `deploy/.env.example` и `src/config/env.ts`):

| Переменная | Обязательна | Что делает |
|---|---|---|
| `HMWRK_PARENT_KEY` | да | статический ключ роли «родитель»; контейнер без него не стартует |
| `HMWRK_CHILD_KEY` | да | статический ключ роли «ребёнок»; контейнер без него не стартует |
| `LOG_LEVEL` | нет (`info`) | `debug` включает строку `chat completion` с `userId`/`role`/`conversationId` — она нужна чек-листу |
| `PORT` | нет (`8787`) | порт внутри контейнера; compose всё равно фиксирует `8787` |
| `DATA_DIR` | нет (`./data`) | внутри контейнера перекрыт на `/data` (volume `hmwrk-data`) |
| `MODELS_CONFIG` | нет | абсолютный путь к `models.json` вместо `/data/models.json`; оставь пустым |
| `GROQ_API_KEY`, `MISTRAL_API_KEY` | нет | нужны с M2; в M1 (echo) не используются |
| `TELEGRAM_BOT_TOKEN` | нет | нужен с M3; в M1 не используется |
| `TZ` | нет (`Europe/Moscow`) | локальное время напоминаний, читает Node |

`LOG_LEVEL=debug` после проверки можно вернуть в `info` — но для чек-листа он нужен.

## Шаг 2. `models.json` в volume

Ядро читает `models.json` при старте и падает, если файла нет (`Cannot load models config
from /data/models.json: file not found…`). В образ файл не входит — он кладётся в volume
`hmwrk-data` один раз:

```bash
cp ../models.example.json models.json
docker compose build
docker compose run --rm -v "$PWD/models.json:/tmp/models.json:ro" --entrypoint sh hmwrk \
  -c 'mkdir -p /data && cp /tmp/models.json /data/models.json'
```

Для M1 (echo) реальные model id не нужны: важна только валидность файла по схеме
(`read`/`verify`/`chat`, провайдер `groq`/`mistral`, непустой `modelId`), поэтому
заглушки из `models.example.json` проходят. Реальные id подставит M2.

## Шаг 3. Подъём стека и health

```bash
docker compose up -d
docker compose ps
```

Ожидаемо: `hmwrk` — `healthy`, `open-webui` — `up` (он стартует только после healthcheck
ядра). Первый старт `open-webui` тянет образ по закреплённому тегу `ghcr.io/open-webui/open-webui:v0.13.4`;
апгрейд — правка тега в `docker-compose.yml`, а не «latest».

Проверить ядро изнутри (порт наружу не опубликован):

```bash
docker compose exec hmwrk node -e 'fetch("http://127.0.0.1:8787/healthz").then(r=>r.text()).then(console.log)'
# {"status":"ok"}

docker compose exec hmwrk node -e 'const k=process.env.HMWRK_PARENT_KEY;fetch("http://127.0.0.1:8787/v1/models",{headers:{authorization:`Bearer ${k}`}}).then(r=>r.text()).then(console.log)'
# {"object":"list","data":[{"id":"hmwrk","object":"model","created":<unix>,"owned_by":"hmwrk"}]}

docker compose exec hmwrk node -e 'const k=process.env.HMWRK_CHILD_KEY;fetch("http://127.0.0.1:8787/v1/chat/completions",{method:"POST",headers:{authorization:`Bearer ${k}`,"content-type":"application/json"},body:JSON.stringify({model:"hmwrk",messages:[{role:"user",content:"проверка связи"}]})}).then(r=>r.text()).then(console.log)'
# {"id":"chatcmpl-…","object":"chat.completion","created":<unix>,"model":"hmwrk","choices":[{"index":0,"message":{"role":"assistant","content":"проверка связи"},"finish_reason":"stop"}],…}
```

Логи ядра (JSON-строки, по одной на строку) — держать открытыми во время всей настройки:

```bash
docker compose logs -f hmwrk
```

Две строки, которые должны быть на старте: `"msg":"role resolver configured"` +
`"mode":"static-keys"` и `"msg":"hmwrk listening on :8787"`.

`"mode":"static-keys"` — это не ошибка и не недонастройка: в текущей сборке загрузчик не
передаёт ядру справочник пользователей, поэтому сервер об этом честно сообщает и работает
на статических ключах (см. шаг 6).

## Шаг 4. Первый вход в OpenWebUI (админ = родитель)

1. `http://<хост-сервера>:3000`.
2. Первая регистрация создаёт аккаунт — его и делаем **родительским**: имя/email/пароль
   родителя. Первый зарегистрированный пользователь получает роль `admin`.
3. Сразу после входа проверь, что ты админ: в левом меню (или в меню профиля) есть
   `Admin Panel`; под ним — `Settings` и `Users`.

## Шаг 5. Подключение ядра как OpenAI-API

Одна коннекция — самый быстрый путь «увидеть echo». Две коннекции понадобятся только для
fallback-механизма ролей (шаг 7).

1. `Admin Panel → Settings → Connections` (в части сборок это `Admin Settings` из меню
   профиля — смысл тот же, раздел Connections).
2. В блоке `Manage OpenAI API Connections` — `Add Connection`.
3. Заполнить:
   - `Connection Type`: `External` (это только фильтр «External» в выборе модели; на работу
     не влияет — ядро внутри сети compose);
   - `URL`: `http://hmwrk:8787/v1` — именно так, `/v1` обязателен, имя `hmwrk` — имя сервиса
     compose;
   - `API Key`: значение `HMWRK_PARENT_KEY` (`grep '^HMWRK_PARENT_KEY=' .env`);
   - `Advanced → Provider`: `Default` (не Azure, не llama.cpp);
   - `Advanced → Auth`: `Bearer`;
   - `Advanced → Model IDs`: можно пусто (ядро отдаёт ровно одну модель `hmwrk`) или вписать
     `hmwrk`; `Advanced → Prefix ID` пока пусто (нужен только в шаге 7).
4. `Save`. В списке моделей (верхний селектор чата) появляется `hmwrk`.
5. Первый чат: выбрать `hmwrk`, написать `проверка связи` → в ответ должен прийти тот же
   текст. В логах ядра при `LOG_LEVEL=debug` появляется
   `"msg":"chat completion","userId":"key:parent","role":"parent","conversationId":"…"`.

Если модели нет в списке — сначала смотри таблицу «Симптом → что проверить» в конце.

## Шаг 6. Роли: механизм (а) — заголовки OpenWebUI (сегодня НЕ включён)

### Что понимает ядро

`src/server/auth.ts` читает три заголовка (регистр не важен, Node/OpenWebUI отдают их в
нижнем регистре):

| Заголовок | Как используется |
|---|---|
| `x-openwebui-user-id` | единственный источник идентичности: по нему ищется строка `users(openwebui_user_id → role)` |
| `x-openwebui-user-name` | только отображаемое имя |
| `x-openwebui-user-email` | объявлен в контракте как подсказка для отображения; `auth.ts` его сейчас не читает |
| `x-openwebui-user-role` | **не читается и не может влиять на роль** — роль берётся только из таблицы `users`, заголовок роли не является полномочием |

Правила резолвера: заголовки приоритетнее ключа (в режиме `hybrid`), неизвестный
`x-openwebui-user-id` — это 401 (`invalid_credentials`), а не тихий откат к ключу; пустой
ключ не совпадает ни с чем.

### Почему сегодня роли идут по ключу

`src/index.ts` собирает резолвер без справочника пользователей (`options.users` не передан),
а `createRoleResolver` в этом случае принудительно понижает режим до `static-keys`. Значит:
даже если OpenWebUI пришлёт `x-openwebui-user-id`, ядро его **проигнорирует** — оно не
доверяет заголовку без таблицы `users`, иначе любой аккаунт получил бы чужую роль.
Таблица `users` появляется с задачей D2 (веха M2), поэтому включение маппинга — отдельная
задача после checkpoint, а не настройка в UI.

### Что OpenWebUI вообще посылает

По умолчанию — ничего из этого. Заголовки user-info включаются на стороне OpenWebUI
переменной `ENABLE_FORWARD_USER_INFO_HEADERS=True`; тогда на OpenAI-коннекцию уходят:

```
X-OpenWebUI-User-Name
X-OpenWebUI-User-Id
X-OpenWebUI-User-Email
X-OpenWebUI-User-Role
X-OpenWebUI-Chat-Id          (id чата; с session-инфо)
```

`X-OpenWebUI-Message-Id` на OpenAI-коннекции не отправляется — он только для tool-серверов.
Имена настраиваются переменными `FORWARD_USER_INFO_HEADER_USER_{ID,NAME,EMAIL,ROLE}`. Живая
проверка ниже нужна именно потому, что набор и имена зависят от релиза: у нас закреплён
`v0.13.4`, и факт фиксируем из логов, а не из чужой документации.

Включить (сервис `open-webui` в `docker-compose.yml` не имеет блока `environment`, поэтому
делаем локальный override — файл в git не попадает, это серверная настройка):

```bash
cd deploy
cat > docker-compose.override.yml <<'EOF'
services:
  open-webui:
    environment:
      ENABLE_FORWARD_USER_INFO_HEADERS: "True"
EOF
docker compose up -d
```

Из git-чекаута файл будет виден как untracked — убери его из вывода через
`.git/info/exclude` (строка `deploy/docker-compose.override.yml`) или удали после проверки.

### Как увидеть настоящие заголовки первого запроса (то, что нужно прислать в тред)

Ядро **не печатает заголовки** в логах (в них есть только `userId`/`role` уже после
резолва). Поэтому факт снимаем временным «шпионом» в сети compose — отдельный контейнер на
уже собранном образе `hmwrk:local` (тянуть ничего не надо):

```bash
docker run --rm -it --name headerspy --network hmwrk_internal --entrypoint node hmwrk:local -e '
const http=require("node:http");
http.createServer((req,res)=>{
  console.log(new Date().toISOString(), req.method, req.url);
  console.log(JSON.stringify(req.headers,null,2));
  if(req.url.endsWith("/models")){
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({object:"list",data:[{id:"hmwrk",object:"model",created:0,owned_by:"spy"}]}));
    return;
  }
  let body="";
  req.on("data",c=>body+=c);
  req.on("end",()=>{res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({id:"chatcmpl-spy",object:"chat.completion",created:0,model:"hmwrk",
      choices:[{index:0,message:{role:"assistant",content:"spy ok"},finish_reason:"stop"}]}));});
}).listen(8799,"0.0.0.0");'
```

В другом терминале: `Admin Panel → Settings → Connections → Add Connection` с
`URL = http://headerspy:8799/v1`, любой непустой API Key, `Advanced → Prefix ID = spy`
(иначе шпион отдаёт тот же id `hmwrk` и перекроет рабочую коннекцию) → `Save`. Чтобы модель
была доступна ребёнку: `Admin Panel → Settings → Models → spy.hmwrk → ⋯ → Access` →
группа `children` с `Read` (если записи модели ещё нет — сначала `Make Private`, шаг 7.3).

Порядок важен: для «шпиона» нужны и группа `children`, и аккаунт ребёнка — если ты ещё не
сделал шаги 7.3 и 8, сделай их сначала (шаг 5 при этом остаётся как есть).

Дальше **каждым аккаунтом** (сначала родитель, потом ребёнок) отправить одно сообщение в
модель `spy.hmwrk` — в терминале «шпиона» появятся два JSON-объекта с полным набором
заголовков (плюс запросы `GET /v1/models`). Их и нужно приложить в тред (см.
`docs/verification/openwebui-checklist.md`). После снятия: `Ctrl-C` в терминале шпиона и
удалить временную коннекцию в UI.

Читать вывод так: если в `req.headers` есть `x-openwebui-user-id` — OpenWebUI передаёт
идентичность и механизм (а) реализуем (после D2: строки в `users` + передача справочника в
`bootstrap`). Если заголовков нет ни при `ENABLE_FORWARD_USER_INFO_HEADERS=True`, ни без
него — фиксируем fallback (механизм (б)) как основной и правим ADR/SPEC.

## Шаг 7. Роли: механизм (б) — два ключа, две коннекции (работает сегодня)

Смысл: ключ = роль. Одно подключение — ключ родителя, второе — ключ ребёнка. Ядро отдаёт
стабильные синтетические id `key:parent` / `key:child`, то есть у каждого ключа своя
durable-беседа.

1. Вторая коннекция: `Admin Panel → Settings → Connections → Add Connection`,
   `URL = http://hmwrk:8787/v1`, `API Key = HMWRK_CHILD_KEY`.
2. Важно: у обеих коннекций ядро отдаёт один и тот же id модели `hmwrk`, а OpenWebUI при
   совпадении id оставляет модель **только из верхней коннекции**. Поэтому задать разные
   `Advanced → Prefix ID`:
   - коннекция с родительским ключом → `parent`;
   - коннекция с детским ключом → `child`.
   В селекторе появятся `parent.hmwrk` и `child.hmwrk` (префикс срезается перед запросом к
   ядру — на стороне ядра модель по-прежнему `hmwrk`).
3. Доступ по группам (ADR 0001/0004: ребёнок видит только «наши» модели):
   - `Admin Panel → Users → Groups → Create New Group`, имя `children`, добавить туда
     аккаунт ребёнка;
   - `Admin Panel → Settings → Models` — это список базовых моделей: найти `child.hmwrk`,
     в меню `⋯ → Access` добавить группу `children` с правом `Read`. Если пункт `Access`
     ещё недоступен (у базовой модели нет сохранённой записи), сначала нажать в том же меню
     `Make Private`/`Make Public` — это создаёт запись модели (без записи базовая модель
     доступна только админу) — и затем выдать доступ группе;
   - у `parent.hmwrk` доступ оставить админским (админ видит всё) — ребёнку он не нужен.
4. Проверка: под аккаунтом ребёнка в селекторе есть `child.hmwrk` и нет `parent.hmwrk`;
   сообщение возвращается echo, а в логах ядра — `"userId":"key:child","role":"child"`.

Ограничения этого механизма (принимаем осознанно, SPEC §4 / ADR 0004):

- роль и беседа привязаны к ключу, а не к аккаунту OpenWebUI: два аккаунта с одним ключом
  получают одну роль и одну общую историю;
- знание ключа = знание роли; ключи живут в `deploy/.env` и в настройках коннекции;
- ротация ключа = правка `.env` + `docker compose up -d` + правка `API Key` в UI.

## Шаг 8. Ребёнок: аккаунт

1. `Admin Panel → Users → Add User` (кнопка `+`/`Add User` рядом со списком): имя, email,
   пароль ребёнка, роль `user` (не `admin`, не `pending`).
2. Если на инстансе включена регистрация — можно дать ребёнку зарегистрироваться самому;
   первый пользователь уже админ, второй по умолчанию `pending` — тогда его надо
   подтвердить/повысить до `user` в `Admin Panel → Users`.
3. Проверить, что ребёнок не видит админ-панель и не видит модель родителя.

## Симптом → что проверить

| Симптом | Что проверить |
|---|---|
| В OpenWebUI у коннекции «0 models», модель не появилась | `URL` оканчивается на `/v1` (`http://hmwrk:8787/v1`); ключ непустой; в `docker compose logs hmwrk` есть `request rejected` с `code`; `docker compose exec hmwrk node -e 'fetch("http://127.0.0.1:8787/v1/models",{headers:{authorization:`Bearer ${process.env.HMWRK_PARENT_KEY}`}}).then(r=>r.status).then(console.log)'` → ждём `200` |
| 401 `missing_credentials` | поле `API Key` пустое или `Auth = None`; ядру нужен `Authorization: Bearer <ключ>` |
| 401 `invalid_credentials`, «Unknown API key» | ключ не совпадает: сравни `grep '^HMWRK_PARENT_KEY=' deploy/.env` с полем коннекции; после правки `.env` ядро надо перезапустить (`docker compose up -d`), в UI — сохранить коннекцию заново |
| Модель видна родителю, но не ребёнку | базовая модель не выдана группе: `Settings → Models → child.hmwrk → ⋯ → Access` (если записи модели ещё нет — сначала `Make Private`/`Make Public`), группа `children` с `Read` |
| Ребёнок видит модель, но чат отвечает `Model not found` / `base_model_unregistered` | у базовой модели нет записи и/или нет read-доступа именно к ней (обёртка над моделью такой доступ не даёт) |
| Обе коннекции дают одну модель / вторая «пропала» | одинаковый id модели у двух коннекций: задай разные `Prefix ID` |
| Ответ — ровно мой текст | так и должно быть: M1 — echo (`echoTurn`, без модели) |
| Ответа нет, в логах `500` или пусто | `docker compose ps` (контейнер не в `restarting`), `docker compose logs hmwrk`; проверить, что запрос дошёл до ядра (строка `chat completion` при `LOG_LEVEL=debug`) |
| `hmwrk` в `restarting`, в логах `Cannot load models config` | нет `/data/models.json`: повторить шаг 2 |
| `open-webui` не поднимается | он ждёт healthcheck ядра: сначала починить `hmwrk` |
| История «общая» у родителя и ребёнка | у обеих коннекций один ключ: разведи их на `HMWRK_PARENT_KEY`/`HMWRK_CHILD_KEY` (шаг 7) |
| `x-openwebui-user-id` в логах шпиона есть, а роль всё равно по ключу | ожидаемо: справочник `users` появляется с D2; см. шаг 6 |

---

## Что делать после

Пройти `docs/verification/openwebui-checklist.md` и прислать в тред: вывод шпиона с
заголовками первого запроса от обоих аккаунтов + скриншот `Connections`. По этому факту
фиксируется механизм ролей (риск №3): включаем (а) отдельной задачей после D2 или
закрепляем (б) в SPEC §4.
