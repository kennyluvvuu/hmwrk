/**
 * `parse_screenshot` — parent, the debug-grade intake channel (SPEC §5.3, plan W7/P1).
 *
 * The parent attaches a screenshot of the electronic diary; the tool reads it with the vision
 * model (`read` slot, Groq) and answers with a **draft**, never with created assignments:
 *
 * 1. `photo_ids` → `photos` rows (`PhotosRepo`) → bytes (`PhotoFiles`, D2) → `readImages` (V2);
 * 2. a strict JSON answer, validated by {@link ScreenshotDraftSchema} and retried once with the
 *    parse error — V2's contract, applied to intake; a second failure is an honest «не разобрал»;
 * 3. the draft rendered as a RU list a person reads («Математика, срок: не видно — уточни;
 *    пункты: №12, №13») with the confirmation rule: the model shows it, the parent confirms, and
 *    only then does the model call `manual_add_assignment` (SPEC §5.3: confirmation *is* creation,
 *    cancel creates nothing).
 *
 * Honest failure modes, all of them text the model can relay:
 * - no photo bytes → {@link ToolRefusal} naming the photo;
 * - the vision call failed (key, timeout, provider) → refusal with a RU reason;
 * - both answers unparsable → the degraded result: no draft, no guess, a way forward;
 * - the toolset was built without the intake seam (tests, an unusual boot) → says so instead of
 *   pretending the screenshot was read.
 *
 * Nothing here writes to the domain: the tool's only side effect is the model call.
 */

import { LlmError } from "../../llm/index.js";
import type { ImageAttachment } from "../../llm/index.js";
import type { Id, Photo } from "../../domain/types.js";
import { photoCount } from "./format.js";
import {
  degradedScreenshotText,
  intakeCorrectionPrompt,
  intakePrompt,
  parseScreenshotDraft,
  renderScreenshotDraft,
  type ScreenshotIntake,
} from "./screenshot-draft.js";
import { defineDomainTool, ToolRefusal } from "./tool.js";
import type { ToolRun } from "./tool.js";

/** Photos of the current message, ready for the read client. */
interface LoadedPhotos {
  readonly photos: readonly ImageAttachment[];
  /** Per-photo reasons the bytes could not be opened (merged into the draft's warnings). */
  readonly problems: readonly string[];
}

/** Resolve ids → rows → bytes. A single unreadable photo must not sink the others. */
async function loadPhotos(run: ToolRun, intake: ScreenshotIntake, ids: readonly Id[]): Promise<LoadedPhotos> {
  const photos: ImageAttachment[] = [];
  const problems: string[] = [];

  for (const id of ids) {
    let photo: Photo | null;
    try {
      photo = await run.repos.photos.get(id);
    } catch {
      photo = null;
    }
    if (photo === null) {
      problems.push(`фото ${id} не найдено в хранилище`);
      continue;
    }
    try {
      photos.push({ bytes: await intake.photoFiles.read(photo), mime: photo.mime });
    } catch {
      problems.push(`файл фото ${id} не читается с диска`);
    }
  }
  return { photos, problems };
}

/** One bounded vision call; every failure becomes one RU sentence for the parent. */
async function readScreenshots(intake: ScreenshotIntake, photos: readonly ImageAttachment[], prompt: string): Promise<string> {
  try {
    return (await intake.readImages({ photos, prompt })).text;
  } catch (error) {
    throw new ToolRefusal(readFailureText(error, photos.length));
  }
}

/**
 * `LlmError` codes → what the parent can act on. The tool never retries the model call itself:
 * V2's client already bounds the call with a timeout, and the only retry here is the corrective
 * JSON turn (a different prompt, not the same request).
 */
function readFailureText(error: unknown, photos: number): string {
  const reading = `Не смог прочитать ${photoCount(photos)}:`;
  if (error instanceof LlmError) {
    const reason: Record<LlmError["code"], string> = {
      model_unavailable: "модель чтения не настроена (models.json)",
      missing_auth: "нет ключа для модели чтения — родителю нужно проверить env",
      timeout: "модель чтения не ответила за отведённое время",
      request_failed: "провайдер вернул ошибку",
      empty_response: "модель чтения вернула пустой ответ",
      invalid_input: "фото не подошло для чтения (формат или размер)",
    };
    return `${reading} ${reason[error.code]}. Ничего не создано — попробуй ещё раз или заведи задание словами (manual_add_assignment). (${error.message})`;
  }
  return `${reading} внутренняя ошибка. Ничего не создано — попробуй ещё раз или заведи задание словами (manual_add_assignment).`;
}

/** `photo_ids` absent: there is nothing to read, and the alternative is already a working tool. */
function hintOnly(hint: string | undefined): string {
  return [
    "Скриншот не передан: photo_ids пустые, а картинку я не выдумываю.",
    ...(hint === undefined ? [] : [`Подсказку вижу: «${hint}».`]),
    "Если задание уже названо словами — заведи его через manual_add_assignment, родитель подтвердит.",
    "Если это должен быть разбор скриншота — перешли фото в сообщении, они придут как photo_ids.",
  ].join("\n");
}

/** The toolset was built without V2/D2 seams: say so instead of pretending. */
const NOT_WIRED_TEXT = [
  "Разбор скриншотов не подключён на этом стенде: нет клиента чтения картинок, поэтому текст задания со скриншота не прочитан и ничего не создано.",
  "Задание заносится вручную: manual_add_assignment с предметом, пунктами и дедлайном.",
].join("\n");

export const parseScreenshotTool = defineDomainTool({
  name: "parse_screenshot",
  title: "разобрать скриншот",
  description:
    "Разобрать скриншот электронного дневника в черновик заданий: предмет, пункты, срок. Вызывай, когда " +
    "родитель приложил скриншот и просит занести задания из него. Инструмент только читает картинку и " +
    "показывает черновик человеку: задания создаются после подтверждения родителя через manual_add_assignment.",
  argsHint:
    "photo_ids — id скриншотов (1–5, как они пришли в сообщении) и/или hint — текстом, что на скриншоте; " +
    "нужно хотя бы одно из двух.",
  run: async (run, args) => {
    const ids = args.photo_ids ?? [];
    if (ids.length === 0) return hintOnly(args.hint);

    const intake = run.intake;
    if (intake === undefined) return NOT_WIRED_TEXT;

    const loaded = await loadPhotos(run, intake, ids);
    if (loaded.photos.length === 0) {
      throw new ToolRefusal(`Не открыл ни одного скриншота: ${loaded.problems.join("; ")}. Ничего не разобрано и не создано.`);
    }

    const prompt = intakePrompt({ ...(args.hint === undefined ? {} : { hint: args.hint }) });
    const first = await readScreenshots(intake, loaded.photos, prompt);
    let parsed = parseScreenshotDraft(first);

    if (!parsed.ok) {
      // One corrective turn, like V2's verdict retry: the same photos plus the parse errors.
      const second = await readScreenshots(intake, loaded.photos, `${prompt}\n\n${intakeCorrectionPrompt(parsed.problems)}`);
      parsed = parseScreenshotDraft(second);
      if (!parsed.ok) throw new ToolRefusal(degradedScreenshotText(parsed.problems));
    }

    // Photos that could not be opened are part of «что не уверен»: the parent should know that the
    // draft was read from fewer pictures than attached.
    const draft = { ...parsed.draft, warnings: [...loaded.problems, ...parsed.draft.warnings] };
    return renderScreenshotDraft(draft, { photos: loaded.photos.length });
  },
});
