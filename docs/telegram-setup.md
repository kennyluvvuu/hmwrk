# Telegram: токен, chat_id и привязка (RU)

Короткий чек-лист для SPEC §5.6: бот **только отправляет** (`sendMessage`) — напоминание
ребёнку и дайджест родителю. Он не читает сообщения, поэтому chat_id ему нужно сообщить
один раз вручную (команда `/start` в чате ничего не даст).

## 1. Бот и токен

1. В Telegram: [@BotFather](https://t.me/BotFather) → `/newbot` → имя и username → получаете
   токен вида `123456789:AA...`.
2. Положите его в `deploy/.env` (или в корневой `.env` для локального `npm start`):

   ```dotenv
   TELEGRAM_BOT_TOKEN=123456789:AA...
   ```

3. Перезапустите ядро: `docker compose up -d` (compose читает `.env` при старте).

`TELEGRAM_API_URL` трогать не нужно: по умолчанию `https://api.telegram.org`. Переменная есть
только для e2e-прогона против локального mock-сервера (`http://127.0.0.1:<port>`, валидация —
http(s) URL).

Проверка токена (ничего не отправляет):

```bash
# на хосте
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"; echo
# в контейнере (curl в образе нет)
docker compose exec hmwrk node -e "fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_BOT_TOKEN+'/getMe').then(r=>r.text()).then(console.log)"
```

Ответ `{"ok":true,"result":{...}}` — токен живой. `{"ok":false,"error_code":401,...}` — токен
неверный или отозван в BotFather.

## 2. Свой chat_id

Напишите [@userinfobot](https://t.me/userinfobot) — он пришлёт `Id: 123456789`. Это и есть
`chat_id`. Для групп id отрицательный (`-100...`), для каналов можно указать `@username`.

Обязательно **нажмите «Start»** в чате со своим ботом (или отправьте ему любое сообщение):
Telegram не даёт боту писать первым.

## 3. Привязка chat_id к роли

Привязка — строка в таблице `tg_bindings` (`user_id → chat_id`). Роль берётся из таблицы
`users`: сначала **войдите в OpenWebUI под нужной ролью** (или отправьте один запрос с
`HMWRK_PARENT_KEY` / `HMWRK_CHILD_KEY`), чтобы строка пользователя появилась. Дальше:

```bash
cd deploy
docker compose exec hmwrk node --import tsx scripts/bind-telegram.ts parent 123456789
docker compose exec hmwrk node --import tsx scripts/bind-telegram.ts child  987654321
```

Успех: `ok: parent → chat_id 123456789 (user Мама, /data/hmwrk.sqlite)`.
Повторный запуск с другим id перепривязывает чат (одна привязка на пользователя), строки не
дублируются. Ошибки: `no user with role "…"` — такого пользователя ещё нет (см. выше);
`2 users have role "…"` — в базе два аккаунта с одной ролью, сначала приведите роли в порядок.

Локально (без Docker, `DATA_DIR` из `.env`):

```bash
node --import tsx scripts/bind-telegram.ts parent 123456789
```

## 4. Проверить доставку

Тестовое сообщение (то же, что в чек-листе юзера) — после привязки:

```bash
cd deploy && docker compose exec hmwrk node --import tsx --input-type=module -e '
import { createTelegramClient } from "./src/telegram/client.ts";
import { renderTestMessage } from "./src/telegram/templates.ts";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chats = { parent: "123456789", child: "987654321" };
for (const [role, chatId] of Object.entries(chats)) {
  await createTelegramClient({ token }).sendMessage({ chatId, text: renderTestMessage({ role, chatId }) });
}
console.log("sent");
'
```

Пришло «hmwrk: проверка связи» — токен, chat_id и сеть в порядке.
`400 can't parse entities` — сломан HTML в шаблоне (данные не экранированы через `escapeHtml`);
`403 bot was blocked by the user` — нажмите Start/unblock в чате; `429 … retry_after` — лимит
Bot API, подождите (клиент не повторяет сам, это решение задачи-рассылки).

## 5. Что дальше

`paused_until` (каникулы) глушит обе рассылки; время — `reminder_time` / `digest_time` в
настройках (SPEC §5.7). Сами рассылки приходят из durable-задач N1 через `TelegramSender` из
`src/contracts/notify.ts`; этот скрипт — единственная ручная операция.
