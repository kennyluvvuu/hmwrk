/**
 * `get_settings` — parent (SPEC §4, §5.7).
 *
 * The parent reads the four knobs before changing them: the two broadcast times, the default due
 * rule, and whether broadcasts are muted. Values are the *effective* ones — the repository merges
 * stored overrides onto the defaults from `src/domain/settings.ts`, so an unset key still answers
 * with the value the family actually lives by.
 *
 * The tool takes no arguments (the schema tolerates an empty object), so it is the one place where
 * «get_settings with junk» is harmless — `additionalProperties: false` rejects anything extra and
 * the model sees the usual validation error.
 */

import { formatDefaultDue, isPaused } from "../../domain/settings.js";
import { formatDay } from "./format.js";
import { defineDomainTool } from "./tool.js";

export const getSettingsTool = defineDomainTool({
  name: "get_settings",
  title: "текущие настройки",
  description:
    "Показать текущие настройки: время напоминания ребёнку, время дайджеста родителю, дедлайн по умолчанию и " +
    "паузу рассылок. Вызывай перед изменением настроек и когда спрашивают «когда приходит напоминание», " +
    "«на какие числа ставим дедлайн», «мы на паузе?».",
  argsHint: "Аргументов нет — вызывай без параметров.",
  run: async (run) => {
    const settings = await run.repos.settings.getAll();
    const paused = isPaused(settings, run.now);

    const lines = [
      "Настройки (действующие значения):",
      `• reminder_time — напоминание ребёнку: ${settings.reminder_time}`,
      `• digest_time — дайджест родителю: ${settings.digest_time}`,
      `• default_due — дедлайн по умолчанию: ${formatDefaultDue(settings.default_due)}`,
      `• paused_until — пауза рассылок: ${
        settings.paused_until === null ? "нет" : `по ${formatDay(settings.paused_until)} включительно`
      }`,
    ];

    if (settings.paused_until !== null && !paused) {
      lines.push(`Сейчас рассылки идут: дата паузы ${formatDay(settings.paused_until)} уже прошла.`);
    } else {
      lines.push(paused ? "Сейчас рассылки на паузе." : "Сейчас рассылки идут.");
    }
    return lines.join("\n");
  },
});
