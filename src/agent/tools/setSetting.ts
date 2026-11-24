/**
 * `set_setting` — parent (SPEC §4, §5.7).
 *
 * One key per call, validated by `parseSettingValue` (T1) before it reaches the repository: the
 * accepted shapes are the ones SPEC §5.7 shows, including the human `default_due` forms
 * (`"20:00 след. дня"`, `"завтра 20:00"`) which are parsed by `src/domain/settings.ts` — the
 * general «к пятнице» stays the agent's job, not this tool's.
 *
 * The tool answers with the old → new pair, so the model can confirm the change the way a person
 * checks it, and says when a schedule change takes effect: the reminder/digest tasks read the
 * settings at each planning step (N1), so nothing is restarted here.
 *
 * Invalid values never reach the store: the message names the key and its accepted shape in
 * Russian instead of relaying a zod path.
 */

import { parseSettingValue } from "../../domain/schemas.js";
import { formatDefaultDue } from "../../domain/settings.js";
import type { DefaultDue, IsoDate, SettingKey, Settings, TimeOfDay } from "../../domain/types.js";
import { DomainError } from "../../domain/errors.js";
import { formatDay } from "./format.js";
import { defineDomainTool, ToolRefusal } from "./tool.js";

/** Accepted shape of each key, in the words a parent would need to fix a mistake. */
const SETTING_HINT: Record<SettingKey, string> = {
  reminder_time: "время напоминания ребёнку в формате ЧЧ:ММ, например 19:00",
  digest_time: "время вечернего дайджеста родителю в формате ЧЧ:ММ, например 21:00",
  default_due: 'правило дедлайна: {"offset_days":1,"time":"20:00"} или строка «20:00 след. дня», «завтра 20:00»',
  paused_until: "дата, до которой рассылки молчат, в формате ГГГГ-ММ-ДД, или null, чтобы снять паузу",
};

/** Human rendering of one stored value — used for both sides of the «было → стало» answer. */
function describeValue(key: SettingKey, value: Settings[SettingKey]): string {
  switch (key) {
    case "reminder_time":
    case "digest_time":
      return value as TimeOfDay;
    case "default_due":
      return formatDefaultDue(value as DefaultDue);
    case "paused_until":
      return value === null ? "паузы нет" : `до ${formatDay(value as IsoDate)} включительно`;
  }
}

export const setSettingTool = defineDomainTool({
  name: "set_setting",
  title: "изменить настройку",
  description:
    "Изменить одну настройку: reminder_time (напоминание ребёнку), digest_time (дайджест родителю), default_due " +
    "(дедлайн по умолчанию) или paused_until (пауза рассылок на каникулы). Вызывай, когда родитель просит " +
    "поменять время рассылок, правило дедлайна или поставить/снять паузу.",
  argsHint:
    "key — reminder_time | digest_time | default_due | paused_until, value — в формате этой настройки " +
    "(время ЧЧ:ММ, правило дедлайна объектом или строкой, дата ГГГГ-ММ-ДД либо null для паузы).",
  run: async (run, args) => {
    const before = await run.repos.settings.get(args.key);

    let value: Settings[SettingKey];
    try {
      value = parseSettingValue(args.key, args.value);
    } catch (error) {
      const detail = error instanceof DomainError || error instanceof Error ? error.message : String(error);
      throw new ToolRefusal(
        `Не понял значение для ${args.key}: нужно ${SETTING_HINT[args.key]}. Ничего не изменено. (${detail})`,
      );
    }

    await run.repos.settings.set(args.key, value);
    const lines = [
      `Настройка ${args.key} изменена: ${describeValue(args.key, before)} → ${describeValue(args.key, value)}.`,
    ];

    switch (args.key) {
      case "reminder_time":
        lines.push("Новое время применится к следующим напоминаниям ребёнку.");
        break;
      case "digest_time":
        lines.push("Новое время применится к следующему дайджесту.");
        break;
      case "default_due":
        lines.push("Дедлайн по умолчанию используется, когда родитель не назвал дату.");
        break;
      case "paused_until":
        lines.push(value === null ? "Рассылки снова идут." : "Напоминания и дайджест молчат до конца этого дня включительно.");
        break;
    }
    return lines.join("\n");
  },
});
