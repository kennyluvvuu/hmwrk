/**
 * `parse_screenshot` — parent, deliberate M1 stub (SPEC §5.3, plan §6).
 *
 * The intake flow is «screenshot → vision → draft assignments → parent confirms». The vision half
 * is W7/P1 (`src/media`, Groq read slot); M2 must not drag it in, so the tool exists with the
 * final argument shape (`photo_ids`, `hint`) and answers honestly instead of pretending.
 *
 * Why a stub and not a missing tool: the prompt (A1) advertises the SPEC §5.5 list, and a model
 * that cannot call the tool would invent an answer. Here it gets a sentence it can relay:
 * «разбор появится позже», plus the working alternative — `manual_add_assignment`.
 */

import { photoCount } from "./format.js";
import { defineDomainTool } from "./tool.js";

export const parseScreenshotTool = defineDomainTool({
  name: "parse_screenshot",
  title: "разбор скриншота",
  description:
    "Разобрать скриншот электронного дневника в черновик заданий: предмет, пункты, дедлайн. Вызывай, когда " +
    "родитель приложил скриншот и просит занести задания из него. Пока разбор не подключён — инструмент " +
    "честно об этом скажет; до тех пор задания заводятся вручную (manual_add_assignment).",
  argsHint:
    "photo_ids — id скриншотов (1–5, как они пришли в сообщении) и/или hint — текстом, что на скриншоте; " +
    "нужно хотя бы одно из двух.",
  run: async (_run, args) => {
    const photos = args.photo_ids ?? [];
    const lines = ["Разбор скриншотов ещё не подключён: это веха 3. Задание из картинки я пока не извлекаю."];

    if (photos.length > 0) {
      lines.push(`Скриншот принят (${photoCount(photos.length)}, id: ${photos.join(", ")}), но текст задания из него не прочитан.`);
    }
    if (args.hint !== undefined) {
      lines.push(`Текстовую подсказку вижу: «${args.hint}». По ней тоже ничего не создано.`);
    }

    lines.push(
      "Пока задание заносится вручную: manual_add_assignment с предметом, пунктами и дедлайном — " +
        "я возьму его из твоих слов или из подсказки, а ты подтвердишь.",
    );
    return lines.join("\n");
  },
});
