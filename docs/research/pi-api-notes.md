# pi-durable / pi-ai 1.6.0 — карта фактического API (R1)

Дата: 24.11.2026. Задача: **R1** (см. `plan/2026-11-24_m1-m3-parallel-buildout.md`).

Всё ниже проверено на фактически установленных пакетах, а не на README из интернета.

| Пакет | Версия | Где смотреть |
|---|---|---|
| `@earendil-works/pi-durable` | 1.6.0 | `node_modules/@earendil-works/pi-durable/{README.md,dist/**/*.d.ts}` |
| `@earendil-works/pi-ai` | 1.6.0 | `node_modules/@earendil-works/pi-ai/{README.md,dist/**/*.d.ts}` |
| `@earendil-works/pi-schema` | 1.6.0 | `node_modules/@earendil-works/pi-schema/README.md` |
| `@earendil-works/chord` | 1.6.0 | `node_modules/@earendil-works/chord/dist/**/*.d.ts` |
| `zod` | 4.6.7 | уже в `dependencies` (T0) |

**Метод.** `export npm_config_cache="$TMPDIR/npm-cache"; npm ci` → чтение `README.md` + `dist/**/*.d.ts` → проверка
поведения крошечными scratch-скриптами в `$TMPDIR/r1/*.ts`, запуск `node --import tsx <файл>` (CLI `tsx` в песочнице
падает на unix-сокете). Все сниппеты из этого документа собраны в один файл и проверены
`npx tsc --noEmit --strict`: это те же строки, что исполнялись в scratch-скриптах. В репозиторий scratch-скрипты
не попадают.

Обозначение источников: `harness/types.d.ts:724` — строка в
`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts`; «README §X» — раздел README того же пакета
(README — это ещё и спека поведения, `.d.ts` — подпись API).

---

## Сводка вердиктов (для нетерпеливых)

| K | Вердикт одной строкой |
|---|---|
| K1 | `Harness.open(storage, options, context)`; трогаем `models`, `registry`, `identity`, `settings`, `env`, `onReport`. |
| K2 | **Один** sqlite-файл: `openNodeSqliteDatabase(path)` → `SqliteStorage.open(db, { prefix: "pi_" })`, доменные таблицы — на том же `db`. |
| K3 | durable-индекса «внешний user → conversation» **нет**; храним соответствие сами (session-документ), атомарно с созданием беседы. |
| K4 | `submit()` → `Submission.wait()` → `settled.answer` (EntryId) → `tx.entry(AssistantEntry, id)`; `requestId` идемпотентен в рамках беседы; `answer` в типах **опциональный**. |
| K5 | Частичный ответ: `docs["pi.live"].generation.message` (`AssistantMessage`, `stopReason: "pending"`); дельты = прирост текста. Каденция = `settings.progress.partialIntervalMs` (по умолчанию 100 мс). |
| K6 | echo в M1 — **прямая запись entries в одном commit**, без модели и без задач (0.3 мс, 0 задач). Faux работает, но требует модели + общей очереди ответов. |
| K7 | Аргументы — **JSON Schema** (`pi-schema` или любой); валидация `validateToolArguments` (pi-schema, с coercion). zod в 1.6.0 совместим «из коробки»: `z.toJSONSchema()` (zod 4 уже в deps) — новая зависимость **не нужна**. |
| K8 | Groq: vision = `qwen/qwen3.6-27b`, `qwen/qwen3.8-27b`. Mistral DeepSeek = `deepseek-v4-1-flash-1017`. **Видео-моделей в каталоге 1.6.0 нет ни у кого.** |
| K9 | `defineTask` + `sleepUntil()`; таск живёт между рестартами, `harness.wake()` → `{ active, at }`; фейковые часы = `now` + `setTimer`. Один таск умеет самопланироваться на каждый день. |
| K10 | Картинка = блок `{ type: "image", data: <base64>, mimeType }` в `UserMessage.content` и в `output` инструмента. Лимиты: `model.inputLimits.images.resize` (по умолчанию 2000×2000, 4.5 МБ). |
| K11 | `close()` ждёт возврата кода задач (проверено ~0.7 с на середине стрима); `harness.closed` даёт `SessionEnd`. `readOnly` открывается **только** поверх read-write sqlite (`mode: "read-only"` ломает миграции). |
| K12 | `docs["pi.usage"]` на беседу + `harness.usage()` на сессию. Разбивки «по дням» нет — для дайджеста считаем дельты сами. |

---

## K1. `Harness.open` и `HarnessOptions` 1.6.0

**Сигнатура** (`harness/harness.d.ts`):

```ts
Harness.open<Tool extends ToolRegistration>(storage: Storage, options: HarnessOptions<Tool>, context: Context): Promise<Harness>
```

`HarnessOptions` (`harness/types.d.ts:724-788`) — поля целиком:

| Поле | Тип | Нужно ли нам |
|---|---|---|
| `models` | `Models \| (() => Models)` | **да**, обязательно |
| `registry` | `RegistryReader` | **да**, обязательно (`createRegistry()`) |
| `identity` | `ClientIdentity` | **да** (атрибуция приложения) |
| `settings` | `HarnessSettings \| (() => HarnessSettings \| undefined)` | **да**, геттером |
| `env` | `(target: EnvTarget, context) => ExecutionEnv \| undefined \| Promise<...>` | да (нужен для файловых инструментов; в M1 не обязателен) |
| `onReport` | `(report: Report) => void` | **да** → логгер |
| `now` | `() => number` | нет (дефолт `Date.now`); нужен только тестам |
| `setTimer` | `SetTimer` | нет; нужен тестам |
| `onWake` | `(wake: Wake) => void` | нет — только для хостов, которые «будят» процесс сами (Cloudflare) |
| `conversationCreated` | `(tx, conversation) => void` | опционально: так можно навешивать свои документы на каждую беседу |
| `telemetry` | `TelemetryContext` | нет |
| `readOnly` | `boolean` | нет (см. K11) |

**Атрибуция «hmwrk».** `identity` мёржится поверх `DEFAULT_HARNESS_IDENTITY` — фактическое значение:

```json
{"attribution":{"name":"pi","url":"https://pi.dev","categories":["cli-agent"]}}
```

То есть по умолчанию запросы представляются как pi. Своя атрибуция:

```ts
identity: { attribution: { name: "hmwrk", url: "https://github.com/<owner>/hmwrk" } }
```

Важная деталь: `attribution` реально уходит заголовками только в OpenRouter (`HTTP-Referer`,
`X-OpenRouter-Title`, `X-OpenRouter-Categories`), NVIDIA NIM (`X-BILLING-INVOKE-ORIGIN`) и OpenCode
(`x-opencode-client`) — `utils/identity.d.ts:41-57` и README §Client Identity. Для Groq/Mistral это не даёт
заголовков; при этом `User-Agent` (`pi/<version> (…; <runtime>; …)`) шлётся всегда. Задавать атрибуцию всё равно
стоит (правило проекта), но не ждать от неё влияния на наши два провайдера. `{ attribution: null }` выключает
атрибуцию полностью.

**Фактический открывающий код (проверен tsc и запуском):**

```ts
const harness = await Harness.open(storage, {
  models,                                  // Models из K8
  registry,                                // createRegistry() + наши extensions
  identity: { attribution: { name: "hmwrk", url: "https://github.com/hmwrk" } },
  settings: () => ({ progress: { partialIntervalMs: 50 }, retry: { maxRetries: 3 } }), // геттер: читается при каждом использовании
  env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
  onReport: (report) => logger.warn("pi-durable", { kind: report.kind, error: report.error }),
}, BACKGROUND_CONTEXT);
```

`settings` как функция — рекомендованный путь: README §Settings прямо говорит «read at every use and never stored»,
значения можно менять на ходу без переоткрытия. `Context` — Chord: для HTTP-обработчика берите
`withAbortSignal(req.signal, BACKGROUND_CONTEXT)` (см. K4), для «фоновых» операций — `BACKGROUND_CONTEXT`.

---

## K2. SQLite: путь, префикс и один файл с доменными таблицами

**Сигнатуры** (`storage/sqlite/node.d.ts`, `storage/sqlite/storage.d.ts`):

```ts
type NodeSqliteStorageOptions = NodeSqliteDatabaseOptions & SqliteStorageOptions;
function openNodeSqliteStorage(path: string, options?: NodeSqliteStorageOptions): Promise<SqliteStorage>;

type SqliteStorageOptions = { readonly prefix?: string };            // "pi_"
type NodeSqliteDatabaseOptions = {                                    // из @earendil-works/chord/sqlite/node
  mode?: "read-write" | "read-only";
  walAutoCheckpointPages?: number;   // по умолчанию 1000
  busyTimeoutMs?: number;            // адаптер по умолчанию 5000
};
```

`prefix` — префикс **всех** таблиц и индексов durable-схемы; должен быть SQLite-идентификатором и не начинаться с
`sqlite_`. Смена префикса **не мигрирует** существующие данные (README §Storage).

**Интерфейс адаптера** (`@earendil-works/chord/dist/sqlite/database.d.ts`):

```ts
interface SqliteExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqliteValue[]): Promise<void>;
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number>;
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
}
interface SqliteDatabase extends SqliteExecutor {
  transaction<T>(cb: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

Подсунуть свой объект можно (это структурный интерфейс, `SqliteStorage.open(db, …)` принимает `SqliteDatabase`), но
не нужно: `node:sqlite` (Node ≥ 22.5, у нас `engines.node >= 22`) уже обёрнут, а `better-sqlite3` в deps нет и он
синхронный — обёртка была бы лишней. README §Storage прямо предписывает: «To share the database with host tables,
create an adapter and use it for both Pi and all host queries» — то есть **один** объект `SqliteDatabase` на всё.

**Проверено запуском** (файл `$TMPDIR/r1/shared.sqlite`, до создания harness — своя таблица `users`):

```
tables before harness: pi_conversations,pi_document_revisions,pi_documents,pi_durable_metadata,
  pi_durable_schema,pi_entries,pi_record_ids,pi_submissions,pi_tasks,users
tables after  Harness.open: то же самое (схема создаётся в SqliteStorage.open, а не в Harness.open)
```

Свои таблицы не трогаются, `Harness.open` ничего не добавляет; после рестарта данные на месте.

**Вердикт: один файл.** Спека (разд. 5.2, «SQLite, файл один») реализуема без компромиссов. Два файла не нужны.

```ts
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

const db = await openNodeSqliteDatabase(cfg.dataDir + "/hmwrk.sqlite");
await db.exec(`CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, subject TEXT NOT NULL, due_at INTEGER)`);
const storage = await SqliteStorage.open(db, { prefix: "pi_" });   // durable-таблицы получат префикс pi_
const harness = await Harness.open(storage, options, context);

// доменные запросы — через тот же db (он сериализует операции с Pi-транзакциями)
await db.run("INSERT INTO assignments (id, subject) VALUES (?, ?)", "a1", "Математика");
```

Замечания:

* `openNodeSqliteStorage(path, { prefix })` — тот же результат, но тогда у вас **второе** соединение с файлом для
  доменных таблиц; README предупреждает, что «direct storage calls bypass the queue and may be rolled back with a Pi
  transaction». Для hmwrk берите вариант выше (один `db`).
* WAL + `synchronous = NORMAL` (дефолт): коммиты переживают падение процесса, но не отключение питания.
* Миграции durable-схемы выполняются в `SqliteStorage.open()` в одной транзакции — поэтому на read-only соединении
  открыть storage нельзя (см. K11).

---

## K3. Durable-беседа «на пользователя»

**Создание.** `Conversation` = транскрипт; владение задаётся явно:

```ts
const conv = await harness.createConversation(
  { ownership: { kind: "ownerless" }, agent: { model: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" } } },
  context,
);
```

`ConversationCreateOptions = { ownership: ConversationOwnership; agent?: AgentChange; init?: ConversationInit }`
(`harness/types.d.ts`). `ownership` — `{kind:"ownerless"}` (наша беседа пользователя) или
`{kind:"task", taskId}` (субагент, умирает с задачей). `agent` применяется в том же коммите, `init(tx, id)` — тоже.

**Внутри своего коммита** `tx.createConversation({ ownership })` берёт **только** ownership — агент задаётся
отдельно, экспортируемой `configure(tx, conversationId, change)`. Это легко пропустить: если создать беседу в
`tx` и не вызвать `configure`, она останется без модели и любой submit завершится
`runFailure: { reason: "no_model", detail: "No model is configured" }` (проверено).

**Как найти беседу после рестарта.** Индекса «внешний user id → conversation» в 1.6.0 **нет**:
`ConversationQuery` (`types.d.ts:790`) фильтрует только по `ownerConversationId` / `ownerTaskId`, а
`scanConversations` возвращает все беседы по порядку ID. Значит, соответствие храним сами. Два честных варианта:

1. **session-документ** (`defineDoc({ scope: "session" })`) — durable JSON рядом с транскриптами, пишется в том же
   коммите, что и создание беседы (рекомендуется: нет своей SQL, транзакционность бесплатно);
2. своя таблица `users_conversations` в том же sqlite-файле (K2) — если хочется видеть это в доменной модели.

Проверено на sqlite-файле с рестартом: после `close()` + нового `Harness.open()` документ на месте, беседа
открывается, follow-up submit в неё проходит и получает ответ.

```ts
import { defineDoc, configure } from "@earendil-works/pi-durable";

const UserConvos = defineDoc<{ byUser: Record<string, number> }>({
  kind: "app.user-conversations",   // свой kind, не начинается с "pi."
  version: 1,
  scope: "session",
  initial: () => ({ byUser: {} }),
  checkpointWhen: () => false,      // обязательное поле: true = хранить как полный base
});

async function conversationFor(harness: Harness, userId: string, ctx: Context): Promise<ConversationId> {
  return harness.commit(async (tx) => {
    const map = await tx.doc(UserConvos);
    const known = map.byUser[userId];
    if (known !== undefined) return known as ConversationId;
    const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, created.id, { model: chatModelRef });
    map.byUser[userId] = created.id;          // тот же коммит: либо есть и беседа, и запись, либо ничего
    return created.id;
  }, ctx);
}

const handle = (await harness.conversation(id, context))!;   // после рестарта
await handle.submit({ type: "input", content: text }, context);  // фоллоу-апы — обычным submit
```

**Списком триггерить фоллоу-апы** — это просто `harness.conversation(id)` + `submit()` на каждую беседу; беседы
независимы, `whenBusy` по умолчанию `followUp` (очередь в `docs["pi.inbox"]`). Ничего «пакетного» в API нет.

Замечания:

* `ConversationId` — branded `number` (`types.d.ts`), в JSON документа кладите как `number`, не строкой;
  `ROOT_CONVERSATION_ID === 1` (корневая беседа `root()`).
* `conversation()` возвращает `undefined` для несуществующего id — это же и проверка «есть ли такая беседа».
* `handle.watch()` / `observeConversation()` — для стриминга (K5).

---

## K4. Запрос → ответ для OpenAI-прокси

**Типы** (`harness/types.d.ts:82-100`):

```ts
interface Submission {
  readonly id: SubmissionId;
  status(context): Promise<SubmissionRecord>;
  wait(context): Promise<SettledSubmissionRecord>;   // done | unanswered
  abort(context): Promise<"aborted" | "already_placed" | "settled">;
}
```

`settled` для `type: "input"`: `{ status: "done", entry: EntryId /* запись pi.user */, answer: EntryId /* pi.assistant */ }`
либо `{ status: "unanswered", reason, detail? }`. `reason` — строка; фактически встречаются `aborted`, `reset`,
`model_error`, `no_model`, `turn_limit` (совпадают с `RunFailureReason` в `docs["pi.live"].runFailure`, где есть и
`detail` с текстом ошибки модели), плюс `run_failed` (после `settings.afterFailedRun: "withdraw"`) и `stale`
(устаревшая компакция).

**Идемпотентность `requestId`** — на уровне беседы (`submissionByRequest(conversationId, requestId)`); повторный
`submit` с тем же `requestId` возвращает **ту же** submission и **не** запускает второй прогон (проверено:
`again.id === sub.id`, faux-очередь не тронута).

**Извлечение финального текста** — два равноправных пути: по `answer` или «последняя запись».

```ts
import { AssistantEntry } from "@earendil-works/pi-durable";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

const settled = await sub.wait(context);
if (settled.status === "done" && settled.answer !== undefined) {
  const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer!), context);
  const message = entry?.model?.[0] as AssistantMessage | undefined;
  const text = (message?.content ?? [])
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
}
// альтернатива: const page = await conv.entries({ order: "descending" }, 1, undefined, context);
```

**Грабли, найденные tsc:** `SettledSubmissionRecord = SubmissionRecord & { status: "done" | "unanswered" }` —
пересечение «схлопывает» дискриминант, поэтому `if (settled.status === "done")` **не** сужает `answer`: он остаётся
`EntryId | undefined`. Проверять надо оба поля (см. сниппет). Это же касается `entry` при `unanswered`.

**Конкурентные HTTP-запросы** (проверено): два `submit` подряд в одну беседу — второй уезжает в `docs["pi.inbox"]`
(`mode: "followUp"`), каждый `wait()` получает **свой** ответ; транскрипт получается
`pi.user#8 pi.assistant#12 pi.user#13 pi.assistant#15`.

**Обрыв соединения клиентом.** `Context` — Chord; отменять надо только ожидание:

```ts
import { withAbortSignal } from "@earendil-works/chord/context";

const requestContext = withAbortSignal(req.signal, BACKGROUND_CONTEXT);
const sub = await conv.submit({ type: "input", content: text, requestId }, requestContext);
try {
  const settled = await sub.wait(requestContext);   // отмена клиента реджектит только wait
} catch {
  // прогон продолжается: позже читаем harness.submission(id) / settled.answer
}
```

Проверено: `wait()` реджектится (`client disconnected`), а работа доходит до конца и складывается в транскрипт
(`status: "done"`, `answer: 11`). Если нужно именно **остановить** генерацию (экономия токенов) — только
`conv.abort(context)` / `harness.abortTask(taskId)` / `sub.abort()` (последний снимает ещё не размещённую очередь).

---

## K5. Стриминг: частичный ответ и его свёртка в OpenAI SSE

**Источник частичного ответа** — документ `pi.live` (`harness/live.d.ts:144-181`):

```ts
type LiveState = {
  run?: LiveRun;                                  // пока беседа busy
  generation?: {
    attempt: number;
    retry?: { at: number; error: string };
    deferred?: { pollAt: number };
    message?: JsonRepresentation<AssistantMessage>;   // ← ЧАСТИЧНЫЙ ответ
  };
  tools?: ToolSlot[]; nestedTools?: NestedToolSlot[]; compactions?: CompactionStatus[];
  compactionFailure?: CompactionFailure;
  runFailure?: RunFailure;
};
```

Проверено фактически: `message` — обычный `AssistantMessage` со `stopReason: "pending"`, растущим
`content[{type:"text",text}]`, растущим `usage` и `responseModel`; поле исчезает, когда прогон закончился
(и вместо него остаётся либо `runFailure`, либо пусто).

**Как наблюдать** — `Conversation.watch()` (Chord `WatchHandle`, сериализованный, коммиты складываются):

```ts
const watch = await conv.watch(context);          // watch.value — снимок на момент attach
let sent = 0;
watch.start(async (call) => {                     // слушатель ОБЯЗАН быть async
  if (call.kind !== "value") return;
  const live = call.value.docs["pi.live"] as unknown as LiveState | undefined;
  const message = live?.generation?.message as AssistantMessage | undefined;
  if (!message) return;
  const text = message.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
  if (text.length > sent) { onDelta(text.slice(sent)); sent = text.length; }
});
// ... await watch.stop();
```

Факты из прогона (`tokensPerSecond: 5`, `partialIntervalMs: 1`): длины текста в последовательных коммитах —
`0, 12, 28, 48, 64, 76, 88`; `generation.attempt = 1`, `run.turns = 0`, `run.inputs = [<submissionId>]`.
Каденция частичных коммитов — `settings.progress.partialIntervalMs` (**по умолчанию 100 мс**), запись в storage —
`persistWithinMs` (по умолчанию 1000 мс, deferred commit). Для «гладкого» SSE ставьте `partialIntervalMs: 20–50`.

Замечания:

* `docs` во вьюхе типизированы как `Record<string, JsonObject>` — нужен `as unknown as LiveState` (или
  `harness.snapshot(LiveDoc, conv.id, ctx)` для разового чтения).
* `watch.start(listener)` — `listener: (call, context) => Promise<void>`; обычная `void`-функция не компилируется.
* Один `watch` на беседу держит её view в памяти; для 1 пользователя это нормально, для сотен — `observeConversation`
  с своим окном (`ConversationWindow { min, max, from }`).
* Порядок «финал в транскрипте» vs «очистка pi.live» полагаться не стоит: финальный чанк стройте по **записи**
  (`pi.assistant` через `settled.answer`), а не по `pi.live`.

**Что при abort.** Проверено (3 конфигурации): `conv.abort()` посреди стрима →

* submission → `{ status: "unanswered", reason: "aborted" }`;
* в транскрипт кладётся запись `pi.assistant` со `stopReason: "aborted"`, и в ней **остаётся последний
  закоммиченный частичный текст** (длина ровно та, что успел увидеть watch: 20/16/52 символа в трёх прогонах);
  если abort пришёл до первого progress-коммита — запись будет с пустым текстом;
* `docs["pi.live"]` → `{ runFailure: { reason: "aborted", inputs: [<id>], first: <EntryId> } }`.

То есть клиенту, который уже отдал дельты, ничего доклеивать не нужно; а вот `finish_reason` ему надо выдать
(`"stop"` с `aborted` — или `error`-чанк, решайте по UX).

**Маппинг в OpenAI Chat Completions SSE.** Формат `chat.completion.chunk`:

1. первый чанк: `choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]` (пустой делта-объект
   с ролью — именно так это делают все совместимые сервера);
2. на каждую текстовую дельту: `choices: [{ index: 0, delta: { content: "<дельта>" }, finish_reason: null }]`;
3. финальный чанк: `choices: [{ index: 0, delta: {}, finish_reason: "<stop|length|tool_calls>" }]`, при желании —
   `usage` (OpenAI требует `stream_options.include_usage`, иначе `usage` можно не слать);
4. терминатор: `data: [DONE]\n\n`.

Соответствие `stopReason` → `finish_reason`: `stop → "stop"`, `length → "length"`, `toolUse → "tool_calls"`,
`aborted`/`error → "stop"` (или `error`-чанк + закрытие, решает S2).

```ts
// псевдокод обработчика (S2): один watch, один запрос
res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
send(chunk({ delta: { role: "assistant" }, finish_reason: null }));      // 1
const stopStreaming = await streamText(conv, requestContext, (d) => send(chunk({ delta: { content: d }, finish_reason: null }))); // 2
const settled = await sub.wait(requestContext);                          // authoritative
await stopStreaming();
send(chunk({ delta: {}, finish_reason: mapFinish(settled) }));           // 3
res.write("data: [DONE]\n\n"); res.end();                                // 4
```

---

## K6. Echo для M1: faux-провайдер vs прямая запись

Проверены оба пути на scratch-скрипте (`$TMPDIR/r1/d.ts`).

| | **(б) прямая запись entries** | **(а) fauxProvider** |
|---|---|---|
| Модель в беседе | не нужна | обязательна (`agent.model`), иначе `runFailure: no_model` |
| Задержка одного «ответа» | **0.3 мс** (весь commit) | 7.7 мс (+ планировщик) |
| Задачи | 0 (`harness.inspect()`: tasks 0, submissions 0, scheduling `paused`) | `pi.generation` + submission |
| Ответ на конкурентные запросы | тривиально (свой commit на запрос) | нужна **своя** faux-очередь на каждый запрос: `setResponses` — глобальная очередь провайдера, порядок = порядок старта запросов |
| Что в транскрипте | `pi.user` + `pi.assistant` (ровно то, что нужно UI) | то же, но через генерацию |
| Когда исчезнет | M2 заменит на настоящую генерацию | останется тестовой инфраструктурой |

**Вердикт: (б), прямая запись.** Для echo модель вообще не нужна, а «эхо» — это не генерация; faux пришлось бы
кормить по одному ответу на каждый HTTP-запрос (гонка при параллельных запросах и никакой пользы). Faux оставляем
там, где он уместен: unit-тесты настоящей агентской петли (M2+), потому что он умеет `fauxToolCall`, `fauxThinking`
и `tokensPerSecond` для детерминированного стриминга.

```ts
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const echoMessage = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: "echo", provider: "hmwrk", model: "echo",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
           cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: Date.now(),
});

async function echo(conv: Conversation, prompt: string, ctx: Context) {
  await conv.commit(async (tx) => {                       // один атомарный коммит на запрос
    await tx.appendEntry(UserEntry, conv.id, { model: [{ role: "user", content: prompt, timestamp: Date.now() }] });
    await tx.appendEntry(AssistantEntry, conv.id, { model: [echoMessage(prompt)] });
  }, ctx);
}
```

Что проверено: запись читается обратно как `pi.assistant` с `content[0].text === prompt`; `conv.context(ctx)` видит
`[user, assistant]`; задач не создаётся; сообщение не «busy». Стриминговый echo для SSE — те же два entry плюс
синтетические чанки (K5), без watch.

Оговорка для S2: `appendEntry` — не submission, поэтому `requestId`-идемпотентность сюда не приходит. Если OpenWebUI
ретраит запрос, в транскрипте появится дубль. Дёшево лечится своей таблицей `echo_requests(request_id PK)` в том же
`db` (K2) или переходом на `submit(tx, { type: "write", entry, requestId })` + отдельная проверка. Для M1 (echo)
дубли безвредны, фиксирую как известное ограничение.

---

## K7. Инструменты: `defineTool` / `defineExtension` / `section` и валидация аргументов

**Сигнатуры** (`harness/define.d.ts`):

```ts
function defineTool<P extends object, D extends JsonValue = JsonValue, C extends JsonValue = JsonValue>(
  tool: ToolRegistration<P, D, C>): ToolRegistration<P, D, C>;
function defineExtension<Tool extends ToolRegistration = ToolRegistration>(e: Extension<Tool>): Extension<Tool>;
function section<Tool>(key: string, render: PromptSection<Tool>["render"], options?: { tag?: boolean }): PromptSection<Tool>;
function hook<K extends AnyTask>(task: K, handlers: Partial<HooksOf<K>>): HookRegistration;
function wrapTool<Tool>(tool: Tool, wrapper: (t: Tool) => Tool): Wrap<Tool>;
```

`ToolRegistration` (`harness/types.d.ts:355`) = pi-ai `Tool` (`name`, `description`, `parameters`, `strict?`,
`constrainedSampling?`) **плюс** durable-поля: `replay: "safe" | "unsafe"` (по умолчанию `unsafe`), `executionMode`,
`prepareArguments?(args: unknown)`, `structuredOutputSchema?`, `callers: ("model" | "tools")[]`, `deferred?`,
`outputLimits?: { maxBytes?, maxLines?, retain?: "head" | "tail" }`, `execute(args, api, context)`, `cancel?`.
`Extension` = `{ name, namespace?, tools?, sections?, hooks?, wraps?, tasks? }`.

**Чем валидируются аргументы.** `parameters` — **JSON Schema** (не zod). Harness валидирует через pi-ai
`validateToolArguments()` (`pi-ai/dist/utils/validation.d.ts:19`), который внутри — `pi-schema compile(schema, {coerce:true})`:
сначала **приводит** типы (`"3"` → `3`, `42` → `"42"` для строки, `"true"` → `true`, одиночное значение → массив,
`null` в необязательном поле → «отсутствует»), потом проверяет. Тип `args` в `execute` выводится из `parameters`
через `Static` pi-schema (для «чужих» схем — `unknown`, поэтому в сниппете ниже приведение типа).

**Что видит агент при кривых аргументах** — проверено фактически, запись `pi.tool-result`, `isError: true`:

```
<harness>
[error] Validation failed for tool "count":
  - n: expected integer, got string

Received arguments:
{
  "n": "not-a-number"
}
</harness>
```

плюс `entry.data.diagnostics = [{ severity: "error", code: "invalid_arguments", message: "…" }]`. То есть спека
(«кривые аргументы → человекочитаемая ошибка агенту») выполняется **бесплатно**: модель получает текст ошибки с
путём до поля и своими аргументами и может исправиться. Брошенное из `execute()` исключение даёт такой же
`<harness>[error] kaput</harness>` с `isError: true` и **не** попадает в `onReport` (это результат инструмента, не
сбой).

**Про zod (спека разд. 5.5).** `zod@4.6.7` уже в deps T0, и в zod 4 есть встроенный конвертер `z.toJSONSchema()`.
Проверено: схема из zod принимается как `parameters`, инструмент исполняется, невалидные значения дают ту самую
человекочитаемую ошибку. **`zod-to-json-schema` не нужен** — это была бы лишняя зависимость.

```ts
import { z } from "zod";
import { defineExtension, section } from "@earendil-works/pi-durable";

const CountArgs = z.strictObject({ n: z.number().int().min(1), note: z.string().optional() });
// z.strictObject → additionalProperties: false; обычный z.object() оставляет поле открытым

export const CountTools = defineExtension({
  name: "count",
  tools: [{
    name: "count",
    description: "Count from 1 to n",
    parameters: z.toJSONSchema(CountArgs, { io: "input" }),   // { $schema, type: "object", properties, required, additionalProperties: false }
    execute: async (args) => {
      const { n } = args as z.infer<typeof CountArgs>;        // pi-schema выведет unknown → приводим
      return { output: [{ type: "text" as const, text: `counted ${n}` }] };
    },
  }],
  sections: [section("counting", () => "Count only when asked.", { tag: false })],
});
```

Нюансы `z.toJSONSchema` (видел в выводе): добавляет `"$schema": "https://json-schema.org/draft/2020-12/schema"`
(pi-schema это принимает) и границы `minimum/maximum: ±9007199254740991` для `z.number()`/`int` — косметика в
описании инструмента, на валидацию не влияет. Если хочется совсем чистой схемы для модели — уберите ключи
(`{ ...schema, $schema: undefined }`) или используйте `z.int()`/`z.number().min(…)` (границы останутся, но осмысленные).

**Вердикт для оркестратора:** zod остаётся тем, что требует спека, но как **слой авторства схем** (T1), а не как
валидатор durable. Мост — `z.toJSONSchema()` в контракте `src/contracts/agent.ts` (например,
`toToolParameters(schema)`), новых зависимостей нет. Для пар «объект ↔ аргумент инструмента» это ещё и удобно:
одна zod-схема на доменную команду и на аргументы инструмента.

---

## K8. Провайдеры Groq / Mistral в 1.6.0

**Фабрики и ключи** (`providers/groq.d.ts`, `providers/mistral.d.ts`, README §Environment Variables):

```ts
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";       // Provider<"openai-completions">, GROQ_API_KEY
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral"; // Provider<"mistral-conversations">, MISTRAL_API_KEY
```

`baseUrl` у Groq — `https://api.groq.com/openai/v1`. Без ключа `models.getAuth('groq')` → `undefined`,
`await models.getAvailable()` → `[]` (проверено): удобная проверка конфига на старте (T2/healthz).

**Каталог Groq 1.6.0** (`providers/data/groq.json`, все `type: "chat"`, API `openai-completions`):

| model id | вход | контекст / max out | $/Mtok in/out |
|---|---|---|---|
| `llama-3.1-8b-instant` | text | 131 072 / 131 072 | 0.05 / 0.08 |
| `llama-3.3-70b-versatile` | text | 131 072 / 32 768 | 0.59 / 0.79 |
| `openai/gpt-oss-120b` | text, reasoning | 131 072 / 65 536 | 0.15 / 0.6 |
| `openai/gpt-oss-20b` | text, reasoning | 131 072 / 65 536 | 0.075 / 0.3 |
| `openai/gpt-oss-safeguard-20b` | text, reasoning | 131 072 / 65 536 | 0.075 / 0.3 |
| **`qwen/qwen3.6-27b`** | **text + image**, reasoning | 131 072 / 16 384 | 0.6 / 3.0 |
| **`qwen/qwen3.8-27b`** | **text + image**, reasoning | 131 072 / 16 384 | 0.8 / 4.0 |

Vision-слоты (`input: ["text","image"]`) — только два qwen: у них же задан `inputLimits.images.resize`
(`2000×2000`, 4 718 592 байт, jpegQuality 80).

**Видео-моделей в 1.6.0 нет.** Проверено машинно по всем `providers/data/*.json`: типы записей в каталогах —
`chat` (1698), `classifier` (81), `image` (74); ни одной `video`. Ни Groq, ни кто-либо ещё. Спека (разд. 7) видео
и не требует — слот `read` там «vision-модель»; но если в брифе R1 предполагались «видео-модели Groq», это
допущение неверно.

**Mistral: текстовый DeepSeek.** В каталоге ровно один: **`deepseek-v4-1-flash-1017`** (`api:
"mistral-conversations"`), и он подходит на роль `verify`/`chat`:

```json
{"api":"mistral-conversations","reasoning":true,"input":["text","image"],
 "contextWindow":1048576,"maxTokens":128000,
 "cost":{"input":0.3,"output":1.2,"cacheRead":0.007,"cacheWrite":0},
 "thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"}}
```

Chat-каталог pi-ai по построению содержит только модели с tool calling (README, первая строка), поэтому `deepseek-*`
и все groq-модели **умеют инструменты**; `input` включает `image`, т.е. DeepSeek у Mistral ещё и vision.
Соответственно «supported tools» в каталоге отдельным флагом не выражается — это свойство всей chat-коллекции.

**Модель не из каталога** — `createProvider()` (`models.d.ts:263`): список моделей + реализация API по id.

```ts
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export function buildModels() {
  const models = createModels({ identity: { attribution: { name: "hmwrk", url: "https://github.com/hmwrk" } } });
  models.setProvider(groqProvider());       // GROQ_API_KEY
  models.setProvider(mistralProvider());    // MISTRAL_API_KEY

  // если понадобится id, которого нет в каталоге (переопределяем провайдера "groq" целиком):
  models.setProvider(createProvider({
    id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1",
    auth: { apiKey: envApiKeyAuth("Groq API key", ["GROQ_API_KEY"]) },
    models: [{
      id: "some-new-model", name: "Some new model", api: "openai-completions", provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1", reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192,
      inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4 * 1024 * 1024 } } },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    }],
    api: openAICompletionsApi(),
  }));

  return { models,
    read:   { provider: "groq",    modelId: "qwen/qwen3.8-27b" },
    verify: { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" },
    chat:   { provider: "mistral", modelId: "deepseek-v4-1-flash-1017" } };
}
```

Проверено: custom-модель резолвится (`models.getModel("groq", "some-new-model")`), `input` включает `image`.
Про `compat` (README §OpenAI Compatibility Settings): для Groq/Mistral `compat` в каталоге уже проставлен
(`supportsStrictMode: true` у groq), руками трогать не нужно; `supportsDeveloperRole`/`supportsReasoningEffort`
важны только для «странных» OpenAI-совместимых серверов (Ollama, vLLM, SGLang).

---

## K9. Durable-задачи: `defineTask`, расписание, фейковые часы

**Подпись** (`types.d.ts:330`):

```ts
function defineTask<I, S extends { phase: string }, R, H extends object = object>(d: TaskDefinition<I, S, R, H>): Task<I, S, R, H>;

type TaskDefinition<I, S, R, H> = {
  name: string; version: number;
  initial(input: I): S;                                   // первый durable-checkpoint
  phases: { [P in S["phase"]]: PhaseHandler<I, Extract<S,{phase:P}>, S, R, H> };
  abort(task, runtime, context): Promise<void>;            // обязательный обработчик отмены
  migrate?(input, checkpoint, fromVersion): { input: I; checkpoint: S };
  hooks?: H;
};
```

`PhaseHandler` = `(task: RunningTask, runtime: TaskRuntime, context) => Promise<void>`; `runtime.commit(change)`
возвращает `NextTaskState`:

```ts
{ status: "running", checkpoint }                                     // следующий шаг
{ status: "waiting", checkpoint, on: TaskId[], policy: "failFast"|"allSettled"|"any" }
{ status: "sleeping", checkpoint, until?, signals? }                   // сон без процесса
{ status: "terminal", outcome: { status: "completed", result } | { status: "failed", error } | { status: "aborted" } }
```

Плюс `runtime.sleepUntil(until, checkpoint, ctx)` — то же, что `sleeping`, но отдельным вызовом; `runtime.now()`,
`runtime.setTimer()`, `runtime.memo()`, `runtime.readSignal()`, `runtime.report()`, `runtime.afterTool...` не тут, а в
`ToolExecutionApi`.

**Как таск попадает на расписание.** Создать в коммите и включить планировщик:

```ts
const taskId = await conv.commit((tx) => tx.createTask(DailyReminder, { hour: 19 }, { ownership: { kind: "conversation" } }), context);
harness.resume();     // идемпотентно; submit/wait/waitForTask/resume тоже включают планировщик
```

После первого прогона таск уходит в `sleeping` — процесса не держит, выживает рестарт:
проверено `getTask()` → `{ state: { status: "sleeping" } }`, `harness.wake()` → `{"active":false,"at":68400000}`
(`at` = ближайший дедлайн, epoch-ms по часам `HarnessOptions.now`). Рестарт → `Harness.open()` + `resume()`
доезжает.

**Напоминание в 19:00 — один таск, который сам себя перепланирует** (проверено на фейковых часах: 2 срабатывания
подряд в 19:00 разных суток, таск остаётся живым):

```ts
export const DailyReminder = defineTask<{ hour: number }, { phase: "wait" } | { phase: "deliver" }, null>({
  name: "app.daily-reminder", version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: (task, runtime, ctx) => {
      const DAY = 86_400_000;
      const base = Math.floor(runtime.now() / DAY) * DAY + task.input.hour * 3_600_000;
      return runtime.sleepUntil(base > runtime.now() ? base : base + DAY, { phase: "deliver" }, ctx);
    },
    deliver: async (_task, runtime, ctx) => {
      // ... отправка сообщения ...
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait" } }), ctx);  // → снова sleep
    },
  },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
```

**Смена настройки (время напоминания)** — «пересоздать»: `await harness.abortTask(oldId, ctx)` (проверено:
`"marked"`, затем `waitForTask` → `outcome: { status: "aborted" }`), затем `createTask` с новым временем. Id задач
храните в своём документе настроек (`settings.reminder_task_id`), иначе после рестарта их не найти иначе как
`tx.scanTasks({ kind: "app.daily-reminder", status: "sleeping" }, 1)` — это тоже рабочий путь.

**Фейковые часы в тестах** — только `HarnessOptions.now` + `setTimer`; проверено на самодельном клоке
(массив таймеров + `advance(ms)`), сон срабатывает ровно на `until`:

```ts
let now = 0;
const timers: { at: number; cb: () => void; cancelled: boolean }[] = [];
const setTimer = (cb: () => void, delayMs: number) => { const t = { at: now + delayMs, cb, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
const harness = await Harness.open(storage, { models, registry, now: () => now, setTimer }, context);
```

Важные правила (README §Sleeping and Waking Up, §Persist and Resume):

* фаза не может «поспать в середине»: после рестарта фаза перезапускается с начала, поэтому работа после сна — в
  **следующей** фазе, а нужное состояние — в checkpoint;
* `runtime.commit()`, который не изменил состояние, **фолтит** таск (нужен прогресс);
* `until` хранится по часам хоста: все процессы, открывающие один storage, должны использовать одни часы;
* `sleeping` без `until` и без `signals` — ошибка (`invalid_park` для инструментов, фолт для задач).

---

## K10. Изображения: как картинка попадает в запрос и в инструмент

**Типы** (`pi-ai/dist/types.d.ts:259-292, 377-450`):

```ts
interface ImageContent { type: "image"; data: string /* base64 */; mimeType: string }
interface TextContent  { type: "text"; text: string }
interface UserMessage  { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }
interface ToolResultMessage { role: "toolResult"; toolCallId; toolName; content: (TextContent | ImageContent)[]; isError; … }
```

`UserInput` в pi-durable — это `UserMessage["content"]`, т.е. `submit({ type: "input", content: [...] })` принимает
блоки напрямую. Проверено: запись `pi.user` хранит `model[0].content = [text, image]` (ключи блока:
`type`, `data`, `mimeType`), и `conv.context().messages` отдаёт модели то же самое.

```ts
await conv.submit({
  type: "input",
  content: [
    { type: "text", text: "прочитай задание с фото" },
    { type: "image", data: pngBase64 /* без data:-префикса */, mimeType: "image/png" },
  ],
}, context);
```

**Инструмент возвращает картинку** так же — в `output` (проверено: `pi.tool-result` с `content: [image]`):

```ts
execute: async () => ({ output: [{ type: "image", data: pngBase64, mimeType: "image/jpeg" }] })
```

Для программ-вызывателей (`executeTool`, codemode) одиночная картинка отдаётся как `ImageContent` в
`NestedToolExecutionResult.structuredOutput`; в транскрипт попадает только `output` + `details`.

**Лимиты vision-моделей** — `model.inputLimits.images` (`providers/model-schema.d.ts`):

```ts
ModelInputLimits = { maxRequestBytes?; images?: {
  resize?: { maxWidth?; maxHeight?; maxBytes?; jpegQuality? };
  maxPerMessage?; maxPerRequest?;
} }
```

Значения каталога: у Groq qwen — `2000×2000`, `4 718 592` байт base64, `jpegQuality: 80`; функция
`imageLimits(model)` из `@earendil-works/pi-durable/tools` для faux-модели вернула дефолт
`{maxWidth:2000,maxHeight:2000,maxBytes:4718592}` (проверено). Для M2/M3:

* `fitImage(bytes, mimeType, imageLimits(model), processor)` — привести **входное** вложение к лимитам до `submit`;
* `createFitImagesExtension(processor)` — `afterTool`-хук, который подгоняет картинки **результатов** инструментов
  перед записью в транскрипт (иначе огромное фото навсегда испортит prompt cache);
* процессор: `createNodePhotonImages()` из `@earendil-works/pi-durable/images/node` (WASM, worker thread, ~1.5 с на
  12 Мп); без процессора `read` отдаёт PNG/JPEG/GIF/WebP «как есть» в пределах лимитов и отказывает в остальном.

Практический вывод для hmwrk: фото тетради скорее всего 2–5 МБ JPEG и влезает; но EXIF-поворот и превышение
2000 px — типичный случай, поэтому `createFitImagesExtension` + `fitImage` нужны уже в M2 (задача V2/A2).

**Входящий OpenAI-формат.** В `chat.completions` картинка приходит как
`{ "type": "image_url", "image_url": { "url": "data:image/png;base64,...." } }` (или внешний URL). Для передачи в
pi-durable: разобрать data-URL на `mimeType` + `data`; внешний URL — скачать самим (лимит размера!) или отклонить.
Обратное направление (мы отдаём в OpenAI) картинок не требует.

---

## K11. Завершение: `close()`, `SIGTERM`, `readOnly`

**`close(context)`** (`types.d.ts`, README §Errors): «seal admission, settle admitted commits, then close storage»;
**ждёт возврата кода запущенных задач**. Если код игнорирует свой abort signal, `closed` задерживается.

Проверено на середине стрима (`tokensPerSecond: 4`, close на 300-й мс): `close()` вернулся за **~709 мс**,
`harness.closed` → `{ kind: "closed" }`. После закрытия:

* `submission.status()`/`wait()` **реджектят** (объекты `Submission` привязаны к инвокации) — перечитывать через
  `harness.submission(id)` на новом Harness;
* submission остаётся `placed`; после `Harness.open()` + `resume()` прогон **переотправляется** («A close is not a
  crash: a request it stopped is sent again» — README §Failures and Recovery), в нашем тесте faux-очередь была пуста,
  поэтому прогон завершился `unanswered / model_error` с текстом `No more faux responses queued`, а частичный ответ
  лёг в транскрипт записью `pi.assistant: aborted`.

`SIGTERM` — обычный паттерн, ничего специального в API нет:

```ts
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(1), 10_000).unref();   // страховка от зависшего close
    void harness.close(BACKGROUND_CONTEXT).finally(() => process.exit(0));
  });
}
```

Почему это безопасно: коммиты атомарны, «crash-loop» ограничен `settings.restartLimit` (по умолчанию 5), а
незавершённое поднимается `resume()`. В docker-compose (E1) нужен `STOPSIGNAL SIGTERM` и `stop_grace_period`
больше 10 с.

**`readOnly`** (`HarnessOptions.readOnly`, `harness/types.d.ts:787`) — режим «только смотреть»: open ничего не
восстанавливает, любой commit с записями, `resume()` и всё, что включает планировщик, реджектят `ReadOnlySession`;
`wake()` всегда `{active:false}`. Проверено поверх **read-write** sqlite-открытия: чтение работает
(`entries`, `agent`, `submission.status`), запись и `resume()` → `ReadOnlySession`, `wake()` → `{"active":false}`.

**Ловушка:** `openNodeSqliteStorage(path, { mode: "read-only" })` **не открывается** — `SqliteStorage.open()` всегда
прогоняет миграции в транзакции (`CREATE TABLE IF NOT EXISTS …; INSERT OR IGNORE …`) и падает с
`SQLITE_ERROR: attempt to write a readonly database`. То есть для read-only просмотра нужно read-write соединение
(файловые локи SQLite держат его безопасно рядом с писателем).

**Вердикт для нас:** `readOnly` не нужен — писатель один (наш процесс). Не закладывайте его в S1/T3. Если позже
захочется «смотреть базу снаружи», это отдельный read-only SQL-клиент, а не второй Harness.

---

## K12. Usage и стоимость

**Где лежит.** На каждую беседу — документ `pi.usage` (`harness/usage.d.ts`):

```ts
type UsageState = {
  models: Record<string /* "provider/modelId" */, Usage>;   // ответы модели + попытки суммаризации
  tools:  Record<string /* tool name */, Usage>;            // usage, который вернул инструмент
};
```

`Usage` (`pi-ai/dist/types.d.ts:292`): `{ input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?,
totalTokens, cost: { input, output, cacheRead, cacheWrite, total, totalFromProvider? } }`.

Проверено на faux:

```json
{"models":{"faux/faux-1":{"input":0,"output":2,"cacheRead":0,"cacheWrite":6,"totalTokens":8,
 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}},"tools":{}}
```

**Чтение:**

```ts
const perConversation = await harness.snapshot(UsageDoc, convId, context);  // один пользователь
const total = await harness.usage(context);                                  // вся сессия: models + tools
```

**Для дайджеста-статистики (K12).** Данных достаточно, но с оговоркой: **временного разреза нет** — это накопительные
счётчики, без «за сегодня». Если понадобится «сколько сожгли за сутки», придётся хранить свой снапшот
(`digest_usage` в session-документе: `{ at, models }`) и считать дельту между запусками дайджеста. Для MVP-дайджеста
(SPEC 5.6) статистика не требуется — так что это заметка на будущее, а не блокер.

Стоимость (`cost.total`) — либо оценка по прайсу каталога, либо (`totalFromProvider: true`) счёт провайдера, если он
его отдаёт; у Groq/Mistral — оценка по каталогу. Учитывайте, что `pi.usage` считает и **неудачные/прерванные**
попытки (README §Usage and Cost).

---

## Наблюдения для оркестратора

Места, где фактический API расходится с допущениями спеки/брифа. Для каждого — рекомендация.

1. **SPEC 5.5 «валидация аргументов — zod» — выполнимо, но не так, как может показаться.**
   Валидатор внутри pi-durable — pi-schema (JSON Schema) с coercion; zod годится только как **язык описания**
   схем. `zod@4.6.7` уже стоит и умеет `z.toJSONSchema()`, поэтому `zod-to-json-schema` (новая зависимость) не
   нужен. **Рекомендация: спеку не менять**, но зафиксировать в T1/T3 контракт `toToolParameters(zodSchema)` и
   правило «`z.strictObject` для аргументов инструментов» (`additionalProperties: false`, как у `obj()` в pi-schema).
   Человекочитаемая ошибка модели обеспечена платформой (см. K7) — отдельный код не нужен.

2. **SPEC 5.2 «SQLite, файл один» — подтверждается.** Один `NodeSqliteDatabase` + `SqliteStorage.open(db, {prefix:
   "pi_"})`. **Рекомендация: жить как есть**; в E1/T3 зафиксировать «доменные запросы идут через тот же `db`
   (не через второе соединение)», иначе можно потерять атомарность с Pi-транзакциями.

3. **K8: видео-моделей в pi-ai 1.6.0 нет вообще.** Если бриф/спека где-то предполагали видео (в SPEC 1–12 видео нет,
   есть vision), это надо вычистить из плана: «read»-слот — только image input (Groq qwen3.6/3.8-27b). **Рекомендация:
   править формулировки брифа R1/плана**, спека не меняется.

4. **K11: `readOnly` + read-only sqlite несовместимы.** Появилось бы искушение сделать «второй harness для чтения» —
   не работает. **Рекомендация: зафиксировать «readOnly не используем»** и не тратить на это время в S1.

5. **K3: индекса «внешний user → conversation» нет.** `Core.conversation(userId)` из T3 обязан включать наше
   соответствие (session-документ или таблица). **Рекомендация: уточнить контракт T3** — `conversationFor(user)`
   атомарно создаёт беседу + запись соответствия, и это единственный путь создания «пользовательских» бесед.

6. **K4: `answer`/`entry` опциональны в типах** (`SettledSubmissionRecord` — пересечение, а не union). Код, который
   делает `settled.answer!` без проверки, скомпилируется только с `!`. **Рекомендация: зафиксировать хелпер
   `finalText(settled)` в S2** и не размазывать проверки по обработчику.

7. **K5: стриминг «из коробки» идёт шагом 100 мс** (`settings.progress.partialIntervalMs`). Для OpenWebUI это
   приемлемо, но выглядит рывками. **Рекомендация: поставить 30–50 мс в S1** (дефолт спеки не оговаривает) и
   помнить, что уменьшение интервала = больше коммитов и больше записей в storage.

8. **K5/abort: после `conv.abort()` в транскрипте остаётся `pi.assistant` с `stopReason: "aborted"`** (с последним
   закоммиченным куском текста, иногда пустым). Ничего чистить не нужно, но SSE-клиенту нужно выдать
   `finish_reason` — иначе OpenWebUI будет ждать. **Рекомендация: описать это в S2 как часть контракта.**

9. **K6: echo через прямые entries не идемпотентен по `requestId`.** Для M1 безвредно (echo), но при ретраях
   OpenWebUI в транскрипте появятся дубли. **Рекомендация: жить как есть в M1**, зафиксировать в S2 «после M2
   запросы идут через `submit` + `requestId`» — там идемпотентность уже есть.

10. **K1: `identity.attribution` не влияет на Groq/Mistral** (заголовки атрибуции есть только у OpenRouter/NVIDIA
    NIM/OpenCode). Правило «указать атрибуцию приложения» выполняем, но ждать от неё эффекта не стоит.
    **Рекомендация: жить как есть**, записано в заметке, чтобы никто не «чинил» это в T3.

11. **K12: usage без временного разреза.** Дайджесту-статистике нужен свой снапшот. **Рекомендация: не менять
    спеку (статистика — non-goal),** но помнить при N1/будущем дайджесте.

12. **K9: «расписание при старте» = `createTask` + `resume()` на boot, а не cron.** Задачи живут в storage и
    переживают рестарт, поэтому «перепланирование при смене настройки» — это `abortTask` + `createTask` в одном
    коммите настроек. **Рекомендация: зафиксировать в N1**, что id задач хранятся в документе настроек
    (`app.settings`), иначе после рестарта их можно найти только `scanTasks` по kind.

---

## Приложение: как воспроизвести проверки

```bash
export npm_config_cache="$TMPDIR/npm-cache"
npm ci
node --import tsx <scratch>.ts        # CLI `tsx` в песочнице падает на unix-сокете
```

Сниппеты этого документа не лежат в репозитории отдельными `.ts` (чтобы не менять `tsconfig.json` T0). Они были
собраны в один scratch-файл и проверены `npx tsc --noEmit --strict --target ES2023 --lib ES2023,DOM --module ESNext
--moduleResolution bundler --skipLibCheck --noUncheckedIndexedAccess <файл>` — то есть публикуемый код компилируется.
Кроме того, ключевые из них исполнялись в скриптах ниже.

Проверенные scratch-сценарии (в репозитории их нет, они лежали в `$TMPDIR/r1/`):

| Файл | Что проверял |
|---|---|
| `a.ts` | K2 (общий файл + prefix + свои таблицы), K3 (scanConversations), K4 (submit/wait/entry/requestId), K12 |
| `b.ts` | K3 (session-документ-соответствие + рестарт + follow-up), K5 (watch, `LiveDoc`) |
| `c.ts`, `m.ts`, `n.ts` | K5 (форма частичного ответа, дельты, abort, `runFailure`) |
| `d.ts` | K6 (оба пути echo), K7 (zod→JSON Schema, валидные/невалидные аргументы) |
| `e.ts`, `k.ts` | K9 (sleepUntil, фейковые часы, `abortTask`, суточный самопланирующийся таск, `wake()`) |
| `f.ts` | K10 (картинка в user-сообщении и в результате инструмента, `imageLimits`) |
| `g.ts`, `g2.ts` | K11 (`close()` посреди прогона, реоткрытие + `resume()`, `readOnly`, ловушка `mode: "read-only"`) |
| `h.ts` | K8 (каталоги Groq/Mistral, custom provider, `getAuth` без ключей, отсутствие видео) |
| `i.ts` | K1 (settings-геттер, env, onReport), K7 (coercion, thrown tool) |
| `j.ts` | K4 (конкурентные submit → inbox → свои ответы) |
| `l.ts` | K4 (`withAbortSignal`: отмена ждёт только wait, прогон доезжает) |
