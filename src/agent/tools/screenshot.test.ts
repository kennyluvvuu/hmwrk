/**
 * P1: `parse_screenshot` — the debug-grade intake channel of SPEC §5.3.
 *
 * The vision model is never called over the network here: either a scripted answer
 * (`visionAnswer`) or a real V2 client over pi-ai's faux provider (`readImages`). What the cases
 * pin, in the order the flow runs:
 *
 * - the draft reaches the model as readable RU text and **nothing is created** (confirmation is
 *   `manual_add_assignment`, cancel creates nothing);
 * - an unreadable date is `null` + «уточни» (SPEC §11 risk #5), never a guess;
 * - gating and argument validation are the shared ones (child refused, empty args named);
 * - every dead end is honest: no photo bytes, a provider failure, two unparsable answers, a
 *   toolset without the intake seam.
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../config/logger.js";
import type { ModelsConfig } from "../../config/models.js";
import { createLlmClients, LlmError } from "../../llm/index.js";
import {
  CHILD_CONVERSATION,
  createToolHarness,
  PARENT_CONVERSATION,
  resultText,
} from "./testing/harness.js";

const NO_PHOTO_ID = "00000000-0000-4000-8000-000000000000";

/** Monday 25.11.2026, the day `settings.default_due` in these fixtures points at. */
const DRAFT_JSON = JSON.stringify({
  assignments: [
    {
      subject: "Математика",
      due: "2026-11-25",
      items: [{ label: "№12" }, { label: "№13", note: "стр. 54" }],
    },
  ],
  warnings: [],
});

describe("parse_screenshot: черновик для родителя, а не создание заданий", () => {
  it("читает скриншот, показывает черновик и ничего не создаёт", async () => {
    const harness = createToolHarness({ visionAnswer: DRAFT_JSON });
    const photo = await harness.seedScreenshot();

    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] });
    const text = resultText(result);

    expect(result.isError).toBeUndefined();
    // The subject, the formatted date and both items, as a person reads them.
    expect(text).toContain("«Математика»");
    expect(text).toContain("25.11.2026");
    expect(text).toContain("пункты (2 пункта): №12, №13 (стр. 54)");
    // The confirmation rule: show the parent, create only after the confirmation, via the tool.
    expect(text).toContain("дождись подтверждения");
    expect(text).toContain("manual_add_assignment");
    // Nothing was written: no assignment, no item, no check-in.
    expect(harness.repos.raw.assignments).toHaveLength(0);
    expect(harness.repos.raw.items).toHaveLength(0);

    // The photo bytes reached the read client, and the prompt asks for the JSON draft.
    expect(harness.readCalls).toHaveLength(1);
    expect(harness.readCalls[0]?.photos).toHaveLength(1);
    expect(harness.readCalls[0]?.photos[0]?.mime).toBe("image/jpeg");
    expect(harness.readCalls[0]?.prompt).toContain("Верни ТОЛЬКО один JSON-объект");
  });

  it("нечитаемая дата → null и просьба уточнить, а не догадка", async () => {
    const harness = createToolHarness({
      visionAnswer: JSON.stringify({
        assignments: [{ subject: "Чтение", due: null, items: [{ label: "стр. 12" }] }],
        warnings: ["дата сдачи обрезана"],
      }),
    });
    const photo = await harness.seedScreenshot();

    const text = resultText(await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] }));

    expect(text).toContain("«Чтение»");
    expect(text).toContain("срок: не видно — уточни у родителя");
    expect(text).toContain("дата сдачи обрезана");
    // Risk #5: the model is told to ask before creating — not to fill in tomorrow silently.
    expect(text).toContain("сначала спроси дату");
    expect(harness.repos.raw.assignments).toHaveLength(0);
  });

  it("подсказка родителя уходит в промпт чтения", async () => {
    const harness = createToolHarness({ visionAnswer: DRAFT_JSON });
    const photo = await harness.seedScreenshot();

    await harness.call("parse_screenshot", PARENT_CONVERSATION, {
      photo_ids: [photo.id],
      hint: "дневник, математика №12",
    });

    expect(harness.readCalls[0]?.prompt).toContain("дневник, математика №12");
  });

  it("срок в неожиданном формате не теряет черновик — только предупреждение", async () => {
    const harness = createToolHarness({
      visionAnswer: JSON.stringify({
        assignments: [{ subject: "Физика", due: "25.11", items: [{ label: "№1" }] }],
        warnings: [],
      }),
    });
    const photo = await harness.seedScreenshot();

    const text = resultText(await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] }));
    expect(text).toContain("«Физика»");
    expect(text).toContain("распознан неточно: «25.11»");
    expect(text).toContain("уточни ГГГГ-ММ-ДД");
  });

  it("пустой разбор → честно «заданий не увидел»", async () => {
    const harness = createToolHarness({
      visionAnswer: JSON.stringify({ assignments: [], warnings: ["на фото только расписание"] }),
    });
    const photo = await harness.seedScreenshot();

    const text = resultText(await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] }));
    expect(text).toContain("Заданий на скриншоте не увидел");
    expect(text).toContain("на фото только расписание");
    expect(text).toContain("manual_add_assignment");
  });
});

describe("parse_screenshot: ролевой гейтинг и аргументы", () => {
  it("ребёнку разбор скриншота недоступен — отказ и ни одного вызова модели", async () => {
    const harness = createToolHarness({ visionAnswer: DRAFT_JSON });
    const photo = await harness.seedScreenshot();

    const result = await harness.call("parse_screenshot", CHILD_CONVERSATION, { photo_ids: [photo.id] });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("это действие родителя");
    expect(harness.readCalls).toHaveLength(0);
  });

  it("без photo_ids и без hint — ошибка аргументов", async () => {
    const harness = createToolHarness({ visionAnswer: DRAFT_JSON });
    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, {});
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Не понял аргументы");
    expect(harness.readCalls).toHaveLength(0);
  });

  it("больше пяти фото — ошибка аргументов (лимит схемы)", async () => {
    const harness = createToolHarness({ visionAnswer: DRAFT_JSON });
    const ids = Array.from({ length: 6 }, (_value, index) => `11111111-1111-4111-8111-11111111111${index}`);
    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: ids });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Не понял аргументы");
    expect(harness.readCalls).toHaveLength(0);
  });

  it("текстовая подсказка без фото — модель не вызывается, путь в ручное добавление", async () => {
    const harness = createToolHarness({ visionAnswer: DRAFT_JSON });
    const text = resultText(
      await harness.call("parse_screenshot", PARENT_CONVERSATION, { hint: "чтение, стр. 12" }),
    );
    expect(text).toContain("чтение, стр. 12");
    expect(text).toContain("manual_add_assignment");
    expect(harness.readCalls).toHaveLength(0);
  });
});

describe("parse_screenshot: честные тупики", () => {
  it("неизвестный photo_id — отказ с id, модель не вызвана", async () => {
    const harness = createToolHarness({ visionAnswer: DRAFT_JSON });
    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [NO_PHOTO_ID] });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(NO_PHOTO_ID);
    expect(resultText(result)).toContain("Ничего не разобрано и не создано");
    expect(harness.readCalls).toHaveLength(0);
  });

  it("файл фото пропал с диска — отказ, а не пустой черновик", async () => {
    const harness = createToolHarness({ visionAnswer: DRAFT_JSON });
    const photo = await harness.repos.photos.create({ kind: "screenshot", path: "lost.jpg", mime: "image/jpeg" });

    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("не читается с диска");
    expect(harness.readCalls).toHaveLength(0);
  });

  it("провайдер не ответил — отказ с причиной и без записей", async () => {
    const harness = createToolHarness({
      readImages: async () => {
        throw new LlmError("timeout", "read model did not answer within 1000 ms", "read");
      },
    });
    const photo = await harness.seedScreenshot();

    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] });
    const text = resultText(result);
    expect(result.isError).toBe(true);
    expect(text).toContain("не ответила за отведённое время");
    expect(text).toContain("Ничего не создано");
    expect(text).toContain("manual_add_assignment");
    expect(harness.repos.raw.assignments).toHaveLength(0);
  });

  it("без шва узнавания (нет vision-клиента) — говорит об этом, а не притворяется", async () => {
    const harness = createToolHarness();
    const photo = await harness.repos.photos.create({ kind: "screenshot", path: "x.jpg", mime: "image/jpeg" });

    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] });
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain("не подключён");
    expect(resultText(result)).toContain("manual_add_assignment");
  });
});

describe("parse_screenshot: строгий разбор ответа модели (V2-дисциплина)", () => {
  it("первый ответ — мусор: одна коррекция, черновик со второго раза", async () => {
    const answers = ["Извините, не могу разобрать картинку.", DRAFT_JSON];
    const harness = createToolHarness({
      visionAnswer: () => answers.shift() ?? "",
    });
    const photo = await harness.seedScreenshot();

    const text = resultText(await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] }));

    expect(harness.readCalls).toHaveLength(2);
    expect(harness.readCalls[1]?.prompt).toContain("Предыдущий ответ не удалось разобрать");
    expect(text).toContain("«Математика»");
    expect(harness.repos.raw.assignments).toHaveLength(0);
  });

  it("два неразбираемых ответа — degraded: ничего не выдумано, есть путь дальше", async () => {
    const harness = createToolHarness({ visionAnswer: "не JSON, честное слово" });
    const photo = await harness.seedScreenshot();

    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] });
    const text = resultText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("Не разобрал скриншот в структуру заданий");
    expect(text).toContain("ничего не создано");
    expect(text).toContain("manual_add_assignment");
    expect(harness.readCalls).toHaveLength(2);
    expect(harness.repos.raw.assignments).toHaveLength(0);
  });

  it("ответ не по схеме (лишнее поле) — тоже коррекция, а не тихое угадывание", async () => {
    const answers = [
      JSON.stringify({ assignments: [{ subject: "Математика", due: null, items: [], extra: true }], warnings: [] }),
      JSON.stringify({ assignments: [{ subject: "Математика", due: null, items: [{ label: "№12" }] }], warnings: [] }),
    ];
    const harness = createToolHarness({ visionAnswer: () => answers.shift() ?? "" });
    const photo = await harness.seedScreenshot();

    const text = resultText(await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] }));
    expect(harness.readCalls).toHaveLength(2);
    expect(text).toContain("«Математика»");
    expect(text).toContain("пункты (1 пункт): №12");
  });
});

describe("parse_screenshot на faux-LLM: настоящий клиент V2, без сети", () => {
  const SLOTS = {
    read: { provider: "groq", modelId: "intake-vision" },
    verify: { provider: "mistral", modelId: "unused-verify" },
    chat: { provider: "mistral", modelId: "unused-chat" },
  } as const satisfies ModelsConfig;

  it("черновик доходит до модели через readImages из src/llm", async () => {
    const read = fauxProvider({ provider: "groq", models: [{ id: SLOTS.read.modelId, input: ["text", "image"] }] });
    const verify = fauxProvider({ provider: "mistral", models: [{ id: SLOTS.verify.modelId }, { id: SLOTS.chat.modelId }] });
    const models = createModels();
    models.setProvider(read.provider);
    models.setProvider(verify.provider);

    read.setResponses([fauxAssistantMessage(fauxText(DRAFT_JSON))]);

    const clients = createLlmClients({
      models,
      slots: SLOTS,
      logger: createLogger({ level: "error", sink: () => undefined, bindings: { module: "p1-test" } }),
    });

    const harness = createToolHarness({ readImages: (input) => clients.readImages(input) });
    const photo = await harness.seedScreenshot();

    const result = await harness.call("parse_screenshot", PARENT_CONVERSATION, { photo_ids: [photo.id] });
    const text = resultText(result);

    expect(result.isError).toBeUndefined();
    expect(read.state.callCount).toBe(1);
    expect(text).toContain("«Математика»");
    expect(text).toContain("пункты (2 пункта): №12, №13 (стр. 54)");
  });
});
