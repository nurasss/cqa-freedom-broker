import type { Answer, Conversation, Criterion, Evaluation } from "./types.ts";
import { computeScore } from "./score.ts";

export interface BenchmarkPair {
  id: string;
  language: string;
  model: string;
  promptVersion: string;
  gold: Record<string, Answer>;
  predicted: Record<string, Answer>;
  needsReview?: boolean;
}

export interface BenchmarkReport {
  compared: number;
  missing: number;
  mae: number | null;
  criterionAccuracy: Record<string, number | null>;
  naPrecision: number | null;
  naRecall: number | null;
  critical: { precision: number | null; recall: number | null; f1: number | null; tp: number; fp: number; fn: number };
  byLanguage: Record<string, { count: number; mae: number | null; mismatches: number }>;
  scaleConfusion: Record<string, { labels: string[]; matrix: number[][] }>;
  needsReview: number;
  disclaimer: string;
}

const DISCLAIMER =
  "Локальная разметка не является скрытым Ground Truth организаторов и не повторяет их ранжирование команд.";

function same(left: Answer | undefined, right: Answer | undefined): boolean {
  return left === right;
}

function safeDivide(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part / whole) * 1000) / 1000;
}

export function evaluateBenchmark(criteria: Criterion[], pairs: BenchmarkPair[]): BenchmarkReport {
  const totals: number[] = [];
  const per: Record<string, { hit: number; total: number }> = {};
  for (const criterion of criteria) per[criterion.id] = { hit: 0, total: 0 };
  let naPredicted = 0;
  let naTruePositive = 0;
  let naGold = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let missing = 0;
  let needsReview = 0;
  const languageErrors = new Map<string, number[]>();
  const languageMismatches = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const scaleIds = criteria.filter((item) => item.answerType === "scale").map((item) => item.id);
  const scaleConfusion: BenchmarkReport["scaleConfusion"] = {};
  for (const id of scaleIds) {
    const steps = (criteria.find((item) => item.id === id)?.scale?.steps ?? []).map(String);
    const labels = criteria.find((item) => item.id === id)?.naAllowed ? [...steps, "na"] : steps;
    scaleConfusion[id] = { labels, matrix: labels.map(() => labels.map(() => 0)) };
  }

  for (const pair of pairs) {
    if (pair.needsReview) needsReview += 1;
    languageCounts.set(pair.language, (languageCounts.get(pair.language) ?? 0) + 1);
    let mismatches = 0;
    for (const criterion of criteria) {
      const gold = pair.gold[criterion.id];
      const predicted = pair.predicted[criterion.id];
      if (gold === undefined || predicted === undefined) {
        missing += 1;
        continue;
      }
      const bucket = per[criterion.id]!;
      bucket.total += 1;
      if (same(gold, predicted)) bucket.hit += 1;
      else mismatches += 1;
      if (predicted === "na") naPredicted += 1;
      if (gold === "na") naGold += 1;
      if (gold === "na" && predicted === "na") naTruePositive += 1;
      if (criterion.answerType === "flag") {
        if (gold === "yes" && predicted === "yes") tp += 1;
        else if (gold !== "yes" && predicted === "yes") fp += 1;
        else if (gold === "yes" && predicted !== "yes") fn += 1;
      }
      const matrix = scaleConfusion[criterion.id];
      if (matrix) {
        const row = matrix.labels.indexOf(String(gold));
        const col = matrix.labels.indexOf(String(predicted));
        const grid = matrix.matrix[row];
        if (row >= 0 && col >= 0 && grid) grid[col] += 1;
      }
    }
    const goldScore = computeScore(criteria, pair.gold);
    const predictedScore = computeScore(criteria, pair.predicted);
    if (goldScore.total !== null && predictedScore.total !== null) {
      const delta = Math.abs(goldScore.total - predictedScore.total);
      totals.push(delta);
      const bucket = languageErrors.get(pair.language) ?? [];
      bucket.push(delta);
      languageErrors.set(pair.language, bucket);
    }
    languageMismatches.set(pair.language, (languageMismatches.get(pair.language) ?? 0) + mismatches);
  }

  const byLanguage: BenchmarkReport["byLanguage"] = {};
  for (const [language, count] of languageCounts) {
    const errors = languageErrors.get(language) ?? [];
    byLanguage[language] = {
      count,
      mae: errors.length ? Math.round((errors.reduce((sum, item) => sum + item, 0) / errors.length) * 100) / 100 : null,
      mismatches: languageMismatches.get(language) ?? 0,
    };
  }

  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? safeDivide(2 * precision * recall, precision + recall) : precision === null && recall === null ? null : 0;
  return {
    compared: pairs.length,
    missing,
    mae: totals.length ? Math.round((totals.reduce((sum, item) => sum + item, 0) / totals.length) * 100) / 100 : null,
    criterionAccuracy: Object.fromEntries(
      Object.entries(per).map(([id, bucket]) => [id, bucket.total ? Math.round((bucket.hit / bucket.total) * 1000) / 1000 : null]),
    ),
    naPrecision: safeDivide(naTruePositive, naPredicted),
    naRecall: safeDivide(naTruePositive, naGold),
    critical: { precision, recall, f1, tp, fp, fn },
    byLanguage,
    scaleConfusion,
    needsReview,
    disclaimer: DISCLAIMER,
  };
}

export function benchmarkByRun(criteria: Criterion[], pairs: BenchmarkPair[]): Record<string, BenchmarkReport> {
  const groups = new Map<string, BenchmarkPair[]>();
  for (const pair of pairs) {
    const key = `${pair.model} @ ${pair.promptVersion}`;
    groups.set(key, [...(groups.get(key) ?? []), pair]);
  }
  return Object.fromEntries([...groups.entries()].map(([key, group]) => [key, evaluateBenchmark(criteria, group)]));
}

export interface CriterionDetail {
  answer: Answer;
  reason: string;
  evidence: { messageIndex: number; quote: string; speaker?: string; timestampRaw?: string }[];
  checkedRange: { from: number; to: number } | null;
  naReason: string | null;
}

export interface ResultRow {
  // 17 core columns
  conversationId: string;
  externalId: string;
  language: string;
  channel: string;
  groupId: string;
  source: string;
  model: string;
  promptVersion: string;
  checklistVersionId: string;
  status: string;
  baseTotal: number | null;
  finalTotal: number | null;
  critical: boolean;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  calls: number;
  answers: Record<string, string>;

  // Additional fields for organizers & compatibility aliases
  configHash: string;
  conversation_id: string;
  dataset_group_id: string;
  prompt_version: string;
  c08_flag: boolean;
  criteria: Record<string, CriterionDetail>;
  details: Record<string, CriterionDetail>;
}

export function formatEvidenceQuotes(
  evidence?: { messageIndex: number; quote: string; speaker?: string; timestampRaw?: string }[] | null,
): string {
  if (!evidence || evidence.length === 0) return "";
  return evidence
    .map((e) => `[#${e.messageIndex}${e.speaker ? ` ${e.speaker}` : ""}] ${e.quote}`)
    .join("; ");
}

export function formatCheckedRange(range?: { from: number; to: number } | null): string {
  if (!range || typeof range.from !== "number" || typeof range.to !== "number") return "";
  return `${range.from}-${range.to}`;
}

export const UTF8_BOM = "\uFEFF";

export function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",;\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function resultRows(conversations: Conversation[], evaluations: Evaluation[]): ResultRow[] {
  const byId = new Map(conversations.map((item) => [item.id, item]));
  const targetEvals = conversations.length > 0
    ? evaluations.filter((item) => byId.has(item.conversationId))
    : evaluations;

  return [...targetEvals]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((evaluation) => {
      const conversation = byId.get(evaluation.conversationId);
      const results = evaluation.finalResults && evaluation.finalResults.length > 0
        ? evaluation.finalResults
        : evaluation.baseResults;

      const criteria: Record<string, CriterionDetail> = {};
      for (const res of results) {
        criteria[res.criterionId] = {
          answer: res.answer,
          reason: res.reason ?? "",
          evidence: res.evidence ?? [],
          checkedRange: res.checkedRange ?? null,
          naReason: res.naReason ?? null,
        };
      }

      const groupId = conversation?.datasetGroupId ?? "";
      return {
        conversationId: evaluation.conversationId,
        conversation_id: evaluation.conversationId,
        externalId: conversation?.externalId ?? "",
        language: conversation?.language ?? "",
        channel: conversation?.channel ?? "",
        groupId,
        dataset_group_id: groupId,
        source: evaluation.source,
        model: evaluation.model,
        promptVersion: evaluation.promptVersion,
        prompt_version: evaluation.promptVersion,
        checklistVersionId: evaluation.checklistVersionId,
        configHash: evaluation.configHash ?? "",
        status: evaluation.status,
        baseTotal: evaluation.baseTotal,
        finalTotal: evaluation.finalTotal,
        critical: evaluation.finalCritical,
        c08_flag: evaluation.finalCritical,
        promptTokens: evaluation.usage?.promptTokens ?? 0,
        completionTokens: evaluation.usage?.completionTokens ?? 0,
        estimatedCostUsd: evaluation.usage?.estimatedCostUsd ?? 0,
        calls: evaluation.usage?.calls ?? 0,
        answers: Object.fromEntries(results.map((result) => [result.criterionId, String(result.answer)])),
        criteria,
        details: criteria,
      };
    });
}

export function resultsToCsv(rows: ResultRow[]): string {
  const ids = [
    ...new Set(
      rows.flatMap((row) => [
        ...Object.keys(row.answers),
        ...Object.keys(row.criteria ?? {}),
      ]),
    ),
  ].sort();

  const header = [
    "conversationId",
    "externalId",
    "language",
    "channel",
    "groupId",
    "source",
    "model",
    "promptVersion",
    "checklistVersionId",
    "status",
    "baseTotal",
    "finalTotal",
    "critical",
    "promptTokens",
    "completionTokens",
    "estimatedCostUsd",
    "calls",
    ...ids,
    "configHash",
    ...ids.flatMap((id) => [
      `${id}_reason`,
      `${id}_evidence`,
      `${id}_checked_range`,
      `${id}_na_reason`,
    ]),
  ];

  const lines = rows.map((row) =>
    [
      row.conversationId,
      row.externalId,
      row.language,
      row.channel,
      row.groupId,
      row.source,
      row.model,
      row.promptVersion,
      row.checklistVersionId,
      row.status,
      row.baseTotal,
      row.finalTotal,
      row.critical,
      row.promptTokens,
      row.completionTokens,
      row.estimatedCostUsd,
      row.calls,
      ...ids.map((id) => row.answers[id] ?? ""),
      row.configHash,
      ...ids.flatMap((id) => {
        const crit = row.criteria?.[id] ?? row.details?.[id];
        return [
          crit?.reason ?? "",
          formatEvidenceQuotes(crit?.evidence),
          formatCheckedRange(crit?.checkedRange),
          crit?.naReason ?? "",
        ];
      }),
    ]
      .map(csvCell)
      .join(","),
  );

  return UTF8_BOM + [header.join(","), ...lines].join("\n");
}
