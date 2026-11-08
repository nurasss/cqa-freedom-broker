import type { Answer, Criterion, SectionId } from "./types.ts";
import { SECTION_LABEL } from "./types.ts";

/** Decimal HALF_UP. Binary noise is snapped before the halfway test. */
export function roundHalfUp(value: number, digits = 2): number {
  if (!Number.isFinite(value)) throw new Error("Нечисловой итог");
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const microDigits = digits + 6;
  const snapped = Math.round(abs * 10 ** microDigits);
  const micro = 10 ** 6;
  const main = Math.floor(snapped / micro);
  const remainder = snapped % micro;
  const rounded = remainder >= 500_000 ? main + 1 : main;
  return (sign * rounded) / 10 ** digits;
}

export function allowedAnswers(criterion: Criterion): Answer[] {
  if (criterion.answerType === "scale") {
    const steps = criterion.scale?.steps ?? [];
    return criterion.naAllowed ? [...steps, "na"] : [...steps];
  }
  if (criterion.answerType === "yes_no_na") {
    return criterion.naAllowed ? ["yes", "no", "na"] : ["yes", "no"];
  }
  return ["yes", "no"];
}

export function formatAnswer(answer: Answer): string {
  if (answer === "yes") return "ДА";
  if (answer === "no") return "НЕТ";
  if (answer === "na") return "N/A";
  return String(answer);
}

export function answerAllowed(criterion: Criterion, answer: Answer): boolean {
  return allowedAnswers(criterion).some((item) => item === answer);
}

function ratio(criterion: Criterion, answer: Answer): number | null {
  if (answer === "na") return null;
  if (criterion.answerType === "flag") return null;
  if (criterion.answerType === "scale") {
    const max = criterion.scale?.max ?? 0;
    if (max <= 0 || typeof answer !== "number") throw new Error(`Шкала ${criterion.id}`);
    return answer / max;
  }
  if (answer === "yes") return 1;
  if (answer === "no") return 0;
  throw new Error(`Ответ ${criterion.id}`);
}

export interface ScoreLine {
  criterionId: string;
  title: string;
  section: SectionId;
  weight: number;
  answer: Answer;
  applicable: boolean;
  normalized: number | null;
  contribution: number | null;
  critical: boolean;
}

export interface SectionScore {
  id: SectionId;
  label: string;
  applicableWeight: number;
  contribution: number;
  percent: number | null;
}

export interface ScoreOutcome {
  status: "ok" | "not_scorable" | "invalid";
  total: number | null;
  raw: number | null;
  critical: boolean;
  denominator: number;
  lines: ScoreLine[];
  sections: SectionScore[];
  error?: string;
}

export function computeScore(
  criteria: Criterion[],
  answers: Record<string, Answer>,
): ScoreOutcome {
  const lines: ScoreLine[] = [];
  let denominator = 0;
  let weighted = 0;
  let critical = false;

  for (const criterion of criteria) {
    if (!(criterion.id in answers)) {
      return {
        status: "invalid",
        total: null,
        raw: null,
        critical: false,
        denominator: 0,
        lines: [],
        sections: [],
        error: `Нет ответа ${criterion.id}`,
      };
    }
    const answer = answers[criterion.id]!;
    if (!answerAllowed(criterion, answer)) {
      return {
        status: "invalid",
        total: null,
        raw: null,
        critical: false,
        denominator: 0,
        lines: [],
        sections: [],
        error: `${criterion.id}: значение ${String(answer)} не из шкалы`,
      };
    }
    const isFlag = criterion.answerType === "flag";
    if (isFlag && answer === "yes") critical = true;
    const applicable = !isFlag && answer !== "na";
    let normalized: number | null = null;
    let contribution: number | null = null;
    if (applicable) {
      normalized = ratio(criterion, answer);
      contribution = (normalized ?? 0) * criterion.weight;
      denominator += criterion.weight;
      weighted += contribution;
    }
    lines.push({
      criterionId: criterion.id,
      title: criterion.title,
      section: criterion.section,
      weight: criterion.weight,
      answer,
      applicable,
      normalized,
      contribution,
      critical: isFlag && answer === "yes",
    });
  }

  const sections = sectionScores(lines);
  if (denominator === 0) {
    return {
      status: "not_scorable",
      total: null,
      raw: null,
      critical,
      denominator: 0,
      lines,
      sections,
    };
  }
  const raw = (100 * weighted) / denominator;
  return {
    status: "ok",
    total: roundHalfUp(raw, 2),
    raw,
    critical,
    denominator,
    lines,
    sections,
  };
}

function sectionScores(lines: ScoreLine[]): SectionScore[] {
  const ids: SectionId[] = [
    "opening",
    "safety_resolution",
    "dialogue",
    "critical",
    "custom",
  ];
  return ids
    .map((id) => {
      const group = lines.filter((line) => line.section === id);
      if (!group.length) return null;
      const applicableWeight = group
        .filter((line) => line.applicable)
        .reduce((sum, line) => sum + line.weight, 0);
      const contribution = group.reduce((sum, line) => sum + (line.contribution ?? 0), 0);
      return {
        id,
        label: SECTION_LABEL[id],
        applicableWeight,
        contribution,
        percent:
          applicableWeight > 0 ? roundHalfUp((100 * contribution) / applicableWeight, 2) : null,
      };
    })
    .filter((item): item is SectionScore => item !== null);
}

export function validateChecklist(criteria: Criterion[]): string[] {
  const errors: string[] = [];
  if (!criteria.length) errors.push("Нужен хотя бы один критерий");
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,16}$/.test(criterion.id)) {
      errors.push(`Некорректный id «${criterion.id}»`);
    }
    if (ids.has(criterion.id)) errors.push(`Повтор id ${criterion.id}`);
    ids.add(criterion.id);
    if (!criterion.title.trim()) errors.push(`${criterion.id}: пустое название`);
    if (!criterion.rubric.trim()) errors.push(`${criterion.id}: пустая формулировка`);
    if (!Number.isFinite(criterion.weight) || criterion.weight < 0) {
      errors.push(`${criterion.id}: вес`);
    }
    if (criterion.answerType === "flag" && criterion.weight !== 0) {
      errors.push(`${criterion.id}: у флага вес должен быть 0`);
    }
    if (criterion.answerType === "scale") {
      const steps = criterion.scale?.steps ?? [];
      if (steps.length < 2) errors.push(`${criterion.id}: нужны ступени шкалы`);
      if (new Set(steps).size !== steps.length) errors.push(`${criterion.id}: повтор ступеней`);
      const max = criterion.scale?.max ?? 0;
      if (!steps.every((step) => step >= 0 && step <= max)) {
        errors.push(`${criterion.id}: ступень вне 0…max`);
      }
      if (max !== Math.max(...steps)) errors.push(`${criterion.id}: max должен быть верхней ступенью`);
    } else if (criterion.scale) {
      errors.push(`${criterion.id}: шкала только у типа scale`);
    }
    if (criterion.answerType === "yes_no_na" && !criterion.naAllowed) {
      errors.push(`${criterion.id}: тип yes_no_na требует N/A, выберите yes_no`);
    }
    if (criterion.naAllowed && (criterion.answerType === "yes_no" || criterion.answerType === "flag")) {
      errors.push(`${criterion.id}: N/A запрещён для этого типа`);
    }
  }
  return errors;
}
