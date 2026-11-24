# Отчёт верификации M2 (веха 2, задача P2)

Дата: 24.11.2026. Ветка задачи: `bb/p2-e2e-m2-thr_m4wvpkzvh2` (worktree от `main`), коммит — см.
`git log -1` (`test(e2e): M2 homework cycle verification (P2)`).
Окружение прогона: macOS, Node v26.13.1, npm 11.20.0, `tsx` из devDependencies.
Скрипт: `scripts/verify-m2.sh`; faux-сценарий: `scripts/fixtures/faux-m2.json`.

## 1. Итог

| Проверка | Команда | Результат |
|---|---|---|
| E2E-цикл M2 (без ключей) | `bash scripts/verify-m2.sh` | **exit 0, 94 проверки, 0 провалов** (три прогона подряд, включая два чистых) |
| Типы | `npm run typecheck` | зелёно |
| Юнит/интеграционные тесты | `npm test` | 38 файлов, **430 тестов**, зелёно |

Скрипт поднимает реальное ядро (`node --import tsx src/index.ts`, не `npm start`) на временном
`DATA_DIR` в `$TMPDIR`, со свободным портом loopback и `HMWRK_FAUX_LLM=1`. Модели —
scripted faux-провайдер pi-ai (`HMWRK_FAUX_SCRIPT=scripts/fixtures/faux-m2.json`); всё остальное
настоящее: HTTP-эндпоинт, авторизация, приём фото, агентская петля, девять инструментов,
durable-задача `hmwrk.verify` и SQLite. Ключи Groq/Mistral не нужны.

## 2. Что именно проверяется (шаги a–g)

1. **Boot/health/auth.** `/healthz` = 200; `/v1/models` — ровно одна модель `hmwrk`; без ключа и с
   неизвестным ключом — 401 в форме OpenAI; в логе `domain schema ready`, `agent extension
   installed` с девятью инструментами, `answering with the agent`.
2. **a) Родитель добавляет задание.** Запрос «добавь задание математика №12–14 к завтра» →
   faux-агент вызывает `manual_add_assignment`; ответ содержит реальный результат инструмента.
   В БД: одна строка `assignments` (`active`, `source=manual`), три пункта в порядке
   `№ 12, № 13, № 14`, дедлайн из аргумента.

   ```
   Добавил задание: «Математика» — к 01.01.2099 17:00 (дедлайн из аргумента).
   Пункты (3 пункта): № 12, № 13, № 14.
   Статус: ждёт отчёта. id: 152b4ac6-…
   ```

3. **b) Сводка в промпте и список.** Второй запрос («что задано?») идёт по SSE: проверяется
   `content-type: text/event-stream`, завершение `data: [DONE]` и склейка дельт. Склеенный ответ —
   реальный результат `list_assignments`. Отдельно из durable-записи `pi.system` восстанавливается
   системный промпт, который видел модель: в нём есть секция `# Активные задания` и строка
   `Математика — ждёт отчёта` (SPEC §6).

   ```
   Задания (1 из 1):
   • «Математика» — к 01.01.2099 17:00 — ждёт отчёта
      пункты: № 12, № 13, № 14
   ```

4. **c) Отчёт ребёнка с фото.** Сообщение — content parts `text` + `image_url` с
   `data:image/png;base64,…` (1×1 PNG). HTTP-слой сохраняет фото, агент вызывает
   `submit_check_in` с реальными `photo_ids` из сообщения. Проверяется: 200; ответ «принят (1
   фото)», «на проверке», «Проверка запущена»; строка `photos` (`kind=checkin`, `mime=image/png`,
   MIME определён по magic bytes), файл существует в `DATA_DIR/photos/`; `checkins` и
   `checkin_photos`; `assignments.status = in_review`; комментарий ребёнка сохранён. Затем
   опрашивается БД, пока durable-задача не сохранит `verifications(status=draft)`; проверяются
   модель `faux-verify`, три finding'а `ok, missing, ok` и резюме. В логе — все три фазы задачи:
   `photos transcribed`, `model verdict ready`, `draft verification saved`.

5. **d) Черновик видит только родитель.** Родитель: `get_verdicts` показывает
   «черновик (ждёт решения родителя)», резюме, `№ 12: верно`, `№ 13: не найдено`, модель
   `faux-verify`. Ребёнок на свой вопрос получает «Утверждённых вердиктов пока нет» и **не**
   видит id черновика.

6. **e) Утверждение → done.** Родитель «утверди проверку» → `approve_verification`; ответ
   «Вердикт утверждён: «Математика» — сдано». В БД: `verifications.status=approved`,
   `decided_by_user_id` заполнен, `assignments.status=done`. Ребёнок после этого видит
   `Утверждённые вердикты (1)`, статус «утверждён», пункты и id вердикта.

7. **f) Просрочка.** Родитель добавляет «Русский язык, упр. 3, вчера» (`due_at` в прошлом) →
   инструмент отвечает «Дедлайн уже прошёл…». Запрос «что просрочено?» вызывает
   `list_assignments(status=overdue)`: в ответе есть «Русский язык» и пометка «просрочено»,
   сданной «Математики» нет; в БД задание по-прежнему `active` (`overdue` — производное
   состояние, SPEC §5.1). В следующей версии системного промпта строка помечена
   `Русский язык — ждёт отчёта, просрочено`.

8. **g) Идемпотентность и авторизация.** Два одинаковых POST с `X-Request-Id: m2-retry-1`:
   первый добавляет ровно одну запись `pi.user` и одну `pi.submissions`; второй возвращает тот же
   ответ, не добавляет ни одной записи `pi_entries` и не создаёт вторую submission. После цикла
   по-прежнему 401 без ключа и с неизвестным ключом. Разговоров три: родитель, ребёнок и
   household-root, которому принадлежит verify-задача (K3/K9).

## 3. Реальный вывод (сокращённо)

```
== a) parent adds an assignment ==
  ok   the agent confirms the assignment
  ok   three items were stored in order
== b) assignment summary in the prompt (SSE) ==
  ok   the streamed answer carries the real list_assignments result
  ok   the prompt summary contains the new assignment
== c) child reports with a photo ==
  ok   the photo bytes exist on disk (9ff1396e-….png)
  ok   the verify task stored a draft verdict
  ok   the findings follow the verdict JSON
  ok   verify log: draft saved
== d) draft verdict visible to the parent only ==
  ok   the parent sees the per-item verdict
  ok   the child does not see the draft's id
== e) approve → done, then the child sees the verdict ==
  ok   the approval names the terminal assignment state
  ok   the child sees the approved verdict
== f) overdue assignment ==
  ok   the list marks it as overdue
  ok   the prompt summary marks the overdue assignment
== g) requestId retry does not duplicate ==
  ok   the retry adds no durable entries at all
  ok   the retry still has exactly one submission
  ok   401 still holds after the cycle
== shutdown and logs ==
  ok   no error-level log records
  ok   no warnings besides the expected 401s and the faux hook notice

M2 verification passed: 94 checks, 0 failed
```

## 4. Найденные швы и что починено

| Место | Что было | Что сделано |
|---|---|---|
| `src/faux.ts`, `scripts/fixtures/faux-m2.json` | Формат faux-скрипта умел только статические ответы. Для e2e это тупик: id задания, id фото и id вердикта создаются во время прогона, а `submit_check_in`/`approve_verification` без них не вызвать. | В faux-хук добавлены три точных плейсхолдера (только в тестовом hook'е): `$lastToolResultText` (текст предыдущего `toolResult` — в т.ч. как текст ответа), `$lastToolResultId` (первый uuid из него) и `$userPhotoIds` (id фото из блока, который HTTP-слой добавляет к сообщению). Скрипт с плейсхолдером становится response factory; без них формат и поведение прежние. Добавлены юнит-тесты (`src/faux.test.ts`, 430 тестов вместо 426). |
| `src/server/routes.ts` (наблюдение, не правка) | Резервный `requestId` — хэш пользователя и сообщений. Два **одинаковых подряд** сообщения считаются одним запросом: в прогоне повторный вопрос ребёнка «что по математике?» получил закэшированный ответ до утверждения. | Это осознанный trade-off I2, записанный в JSDoc маршрута; e2e использует разные формулировки для двух вопросов ребёнка и отдельно доказывает идемпотентность явным `X-Request-Id`. **Решение за оркестратором/юзером:** либо OpenWebUI должен присылать `X-Request-Id`, либо fallback-хэш стоит дополнить (например, позицией/временем), иначе реальный повтор вопроса вернёт старый ответ. |
| `scripts/verify-m2.sh` | Не существовал. | Новый e2e-скрипт (94 проверки): `set -euo pipefail`, `$TMPDIR`, свободный порт, faux-фикстура, проверки через `jq`/`curl`, чтение SQLite (`sqlite3`, fallback `node:sqlite`). Артефакты сохраняются при провале; `KEEP_ARTIFACTS=1` — и при успехе. |
| Проверки промпта/инструментов | Ответ HTTP может быть любым текстом faux-модели, поэтому «агент увидел задание» по одному ответу не доказать. | Скрипт читает durable-записи `pi_entries`: секции `pi.system` (реальный системный промпт после применения патчей) и `pi.tool-result`. Плюс плейсхолдер `$lastToolResultText` делает HTTP-ответ равным реальному результату инструмента. Это опирается на внутренний формат pi-durable 1.6.0: при апгрейде пакета запросы к `pi_entries` нужно перепроверить. |
| `pi_submissions.request_id` | Значение хранится JSON-строкой (в кавычках). | Учтено в скрипте через `json_extract(request_id, char(36))`; это деталь storage-адаптера, не дефект продукта. |
| Число бесед | M1 ожидал 2; в M2 verify-задача владеет household-root беседой. | Ожидание скрипта — 3 (родитель, ребёнок, root задачи); это соответствует K3/K9. |

Других дефектов кодовой базы прогон не выявил: цикл «добавление → сводка → отчёт с фото →
verify → черновик → утверждение → done → overdue» проходит на реальном ядре без правок
продуктового кода.

## 5. Что осталось на живые ключи (smoke пользователя)

Faux-прогон доказывает склейку и доменный цикл, но **не** качество реальных моделей: Groq vision
должен разобрать почерк, Mistral — вернуть валидный JSON вердикта. Это единственный ручной шаг.

Что заполнить (имена переменных, значения не коммитить):

- `GROQ_API_KEY` — ключ Groq для слота `read` (vision);
- `MISTRAL_API_KEY` — ключ Mistral для слотов `verify` и `chat`;
- `HMWRK_PARENT_KEY`, `HMWRK_CHILD_KEY` — два длинных случайных значения (fallback ролей);
- `DATA_DIR` — каталог данных (например, `./data`);
- `models.json` в `DATA_DIR` (или `MODELS_CONFIG=/abs/path/models.json`) с id из каталога pi-ai:
  `read` — Groq vision-модель (R1 K8: `qwen/qwen3.6-27b`), `verify`/`chat` — Mistral
  (`deepseek-v4-1-flash-1017`). Проверить, что выбранные id всё ещё в каталоге 1.6.0.

Команда локально:

```bash
npm ci
DATA_DIR=./data \
GROQ_API_KEY=… MISTRAL_API_KEY=… \
HMWRK_PARENT_KEY=… HMWRK_CHILD_KEY=… \
npm start                      # слушает 127.0.0.1:8787
```

Дальше — либо подключить OpenWebUI по `docs/setup-openwebui.md`, либо curl'ом:

1. родитель: «добавь задание математика №12–14 к завтра» → в ответе «Добавил задание…»;
2. «что задано?» → задание в списке ведёт себя как активное;
3. ребёнок: реальное фото тетради + «сделал математику» → «Отчёт принят… проверка запущена»;
4. через несколько секунд родитель: «что по проверкам?» → черновик с пунктами и честными
   `unclear` там, где почерк не разобран;
5. «утверди проверку» → «сдано»; ребёнок видит утверждённый вердикт;
6. «добавь задание русский вчера» → «что просрочено?» → пометка «просрочено».

Отдельно стоит посмотреть в логах `verify: photos transcribed` / `verify: model verdict ready`:
если реальная модель дважды вернула невалидный JSON, вердикт будет `degraded` (все пункты
`unclear`) — это штатное поведение SPEC §5.4, а не падение.

Вне M2 и этого прогона: Telegram-рассылки, напоминания/дайджест (M3), Docker/compose (проверяется
на сервере пользователя), OpenWebUI-заголовки (ручной чек-лист G1).

## 6. Воспроизведение

```bash
npm ci
npm run typecheck && npm test
bash scripts/verify-m2.sh                    # exit 0 = зелёно, ключи не нужны
KEEP_ARTIFACTS=1 bash scripts/verify-m2.sh   # оставить логи/ответы/SQLite для разбора
```

Требования: Node ≥ 22, `curl`, `jq`; `sqlite3` желателен, без него используется `node:sqlite`.
Временные файлы — только в `$TMPDIR`.
