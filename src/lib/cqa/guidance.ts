import { officialCriteria } from "./seed.ts";
import type { Criterion } from "./types.ts";

export const OFFICIAL_GUIDANCE: Record<string, string> = {
  C02: "Запрос данных для проверки личности (ИИН, номер счёта, код) — это C03, а не выявление потребности. Если вопрос клиента с самого начала достаточен для ответа — N/A.",
  C04: "Ставь 0 за ошибочную рекомендацию, только если ошибка очевидна из самого диалога или общеизвестна без оговорок. Не снижай за детали, зависящие от внешних обстоятельств, которых нет в диалоге (сезонное время, курсы, правила других стран), если ответ правдоподобен.",
  C06: "Если перед ответом оператора есть отметка паузы 2 минуты и больше, а оператор не предупредил об ожидании — не выше 7. Если клиенту пришлось переспрашивать из-за формулировок или порядка ответов оператора — не выше 4. Грубость сама по себе — это C05 и C08, а не C06.",
  C08: "Раскрытие конфиденциальной информации — это сведения о третьих лицах или внутренние данные компании. Если оператор назвал клиенту его собственные данные до проверки личности — это оценивается в C03, а не в C08.",
};

const officialRubricsById = new Map<string, string>(
  officialCriteria.map((c) => [c.id, c.rubric]),
);

export function getGuidanceForCriterion(criterion: Criterion): string | null {
  const officialRubric = officialRubricsById.get(criterion.id);
  if (!officialRubric) return null;
  if (criterion.rubric !== officialRubric) return null;
  return OFFICIAL_GUIDANCE[criterion.id] ?? null;
}
