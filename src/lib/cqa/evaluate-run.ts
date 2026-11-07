import { assemble, draftsFromModelPayload, type DraftAnswer } from "./engine.ts";
import {
  applySemanticVerdicts,
  judgePrompt,
  parseJudgeResponse,
  scoringPrompt,
  type SemanticVerdict,
} from "./semantic-judge.ts";
import type { Conversation, Criterion, CriterionResult, UsageInfo } from "./types.ts";
import { INPUT_USD_PER_M, MODEL_ID, OUTPUT_USD_PER_M, PROMPT_VERSION } from "./types.ts";

export interface CompleteSuccess {
  ok: true;
  content: string;
  finishReason?: string | null;
  promptTokens: number;
  completionTokens: number;
}

export type EvalErrorCode = "no_api_key" | "auth" | "bad_request" | "transient" | "model_not_found";

export interface CompleteFailure {
  ok: false;
  error: string;
  status?: number;
  code?: EvalErrorCode;
  retryAfter?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export type CompleteResult = CompleteSuccess | CompleteFailure;

export type CompleteFn = (
  model: string,
  maxTokens: number,
  messages: { role: string; content: string }[],
) => Promise<CompleteResult>;

export interface EvaluationDeps {
  complete: CompleteFn;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  isLocal?: boolean;
  priceInputPerM?: number;
  priceOutputPerM?: number;
}

export interface EvalInput {
  conversation: Conversation;
  criteria: Criterion[];
  model?: string;
}

export interface EvalOutput {
  ok: true;
  status: "completed" | "needs_review" | "failed" | "not_scorable";
  results: CriterionResult[];
  total: number | null;
  raw: number | null;
  critical: boolean;
  model: string;
  promptVersion: string;
  usage: UsageInfo;
  trace: string[];
  error?: string;
}

export type EvalResponse =
  | EvalOutput
  | { ok: false; error: string; code?: EvalErrorCode; usage?: UsageInfo };

export function estimateCost(
  promptTokens: number,
  completionTokens: number,
  isLocal = false,
  priceInputPerM = INPUT_USD_PER_M,
  priceOutputPerM = OUTPUT_USD_PER_M,
): number {
  if (isLocal) return 0;
  const usd = (promptTokens / 1_000_000) * priceInputPerM + (completionTokens / 1_000_000) * priceOutputPerM;
  return Math.round(usd * 10_000) / 10_000;
}

export function parseTokenLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const num = Number(value.trim());
  if (Number.isInteger(num) && num > 0) return num;
  return fallback;
}

export function extractJson(content: string): unknown {
  let text = content.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const sliced = text.slice(firstBrace, lastBrace + 1);
      return JSON.parse(sliced);
    }
    throw new Error("JSON не найден в ответе модели");
  }
}

export function classifyErrorCode(status?: number, rawCode?: EvalErrorCode): EvalErrorCode {
  if (rawCode) return rawCode;
  if (status === 404) return "model_not_found";
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 422) return "bad_request";
  return "transient";
}

export function isRetryableResult(result: CompleteFailure): boolean {
  if (
    result.code === "no_api_key" ||
    result.code === "auth" ||
    result.code === "model_not_found" ||
    result.code === "bad_request"
  ) {
    return false;
  }
  // Ошибки без статуса (сеть, таймаут, AbortError) повторяемые
  if (result.status === undefined || result.status === null) {
    return true;
  }
  // 429 и 408 повторяемые
  if (result.status === 429 || result.status === 408) {
    return true;
  }
  // 5xx повторяемые
  if (result.status >= 500 && result.status < 600) {
    return true;
  }
  // Остальные 4xx (400, 401, 403, 404, 422 и др.) НЕ повторяемые
  return false;
}

interface CallTracker {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  trace: string[];
}

async function invokeWithRetry(
  tracker: CallTracker,
  deps: EvaluationDeps,
  model: string,
  maxTokens: number,
  messages: { role: string; content: string }[],
): Promise<CompleteResult> {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delays = [1000, 2000, 4000];
  let lastFailure: CompleteFailure = { ok: false, error: "Нет ответа" };

  for (let attempt = 0; attempt < 3; attempt++) {
    tracker.calls += 1;
    const result = await deps.complete(model, maxTokens, messages);
    tracker.promptTokens += result.promptTokens ?? 0;
    tracker.completionTokens += result.completionTokens ?? 0;

    if (result.ok) {
      tracker.trace.push(`вызов ${tracker.calls}: in ${result.promptTokens} / out ${result.completionTokens}`);
      return result;
    }

    lastFailure = result;
    if (!isRetryableResult(result) || attempt === 2) {
      break;
    }

    let delayMs = delays[attempt] ?? 4000;
    if (typeof result.retryAfter === "number" && result.retryAfter > 0) {
      delayMs = Math.min(Math.max(result.retryAfter * 1000, 0), 15000);
    }
    await sleep(delayMs);
  }

  return lastFailure;
}

async function invokeWithTruncation(
  tracker: CallTracker,
  deps: EvaluationDeps,
  model: string,
  baseMaxTokens: number,
  messages: { role: string; content: string }[],
): Promise<CompleteResult> {
  const first = await invokeWithRetry(tracker, deps, model, baseMaxTokens, messages);
  if (!first.ok) return first;

  if (first.finishReason === "length") {
    tracker.trace.push("truncated");
    const second = await invokeWithRetry(tracker, deps, model, baseMaxTokens * 2, messages);
    return second;
  }

  return first;
}

export async function runEvaluation(input: EvalInput, deps: EvaluationDeps): Promise<EvalResponse> {
  const env = deps.env ?? process.env;
  const requested = input.model?.trim() ?? "";
  const model = /^[A-Za-z0-9._:/-]{1,128}$/.test(requested) ? requested : MODEL_ID;

  const evalMaxTokens = parseTokenLimit(env?.LLM_MAX_TOKENS || env?.XAI_MAX_TOKENS, 6000);
  const judgeMaxTokens = parseTokenLimit(env?.LLM_JUDGE_MAX_TOKENS || env?.XAI_JUDGE_MAX_TOKENS, 3000);

  const isLocal = Boolean(deps.isLocal);

  const priceInputPerM = deps.priceInputPerM ?? INPUT_USD_PER_M;
  const priceOutputPerM = deps.priceOutputPerM ?? OUTPUT_USD_PER_M;

  const tracker: CallTracker = {
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
    trace: [`model ${model}`, `prompt ${PROMPT_VERSION}`],
  };

  const getUsage = (): UsageInfo => ({
    promptTokens: tracker.promptTokens,
    completionTokens: tracker.completionTokens,
    estimatedCostUsd: estimateCost(
      tracker.promptTokens,
      tracker.completionTokens,
      isLocal,
      priceInputPerM,
      priceOutputPerM,
    ),
    calls: tracker.calls,
  });

  const system =
    "Ты модуль Conversation Quality Analytics Freedom Broker. Отвечай только JSON по рубрике переданной версии. Итог в баллах не вычисляй.";
  const messages: { role: string; content: string }[] = [
    { role: "system", content: system },
    { role: "user", content: scoringPrompt(input.criteria, input.conversation) },
  ];

  let lastError = "Модель не вернула пригодный JSON";
  let judgeError: string | undefined;
  let lastAssembly: ReturnType<typeof assemble> | null = null;
  let currentDrafts: DraftAnswer[] = [];

  // Основная оценка модели
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await invokeWithTruncation(tracker, deps, model, evalMaxTokens, messages);
    if (!result.ok) {
      const code = classifyErrorCode(result.status, result.code);
      return { ok: false, error: result.error, code, usage: getUsage() };
    }

    let parsed: unknown;
    try {
      parsed = extractJson(result.content);
    } catch {
      lastError = "JSON модели не разобран";
      messages.push({ role: "assistant", content: result.content.slice(0, 4000) });
      messages.push({
        role: "user",
        content: "Ответ не JSON. Верни полный объект {\"criteria\":[...]} ещё раз, без пояснений.",
      });
      continue;
    }

    const drafted = draftsFromModelPayload(input.criteria, parsed);
    if (drafted.drafts.length !== input.criteria.length) {
      lastError = drafted.errors[0] ?? "Неполный набор критериев";
      messages.push({ role: "assistant", content: result.content.slice(0, 4000) });
      messages.push({
        role: "user",
        content: `Исправь и верни все критерии заново. Ошибки:\n${drafted.errors.join("\n")}`,
      });
      continue;
    }

    currentDrafts = drafted.drafts;
    const assembled = assemble(input.criteria, input.conversation.messages, currentDrafts);
    lastAssembly = assembled;
    tracker.trace.push(...assembled.errors.slice(0, 6));

    const answerErrors = assembled.errors.filter((error) => /недопустим|Нет |Лишний|Дубль/.test(error));
    if (assembled.status !== "failed" && answerErrors.length === 0) {
      break;
    }
    break;
  }

  // ok:false допустим только если не получен ни один пригодный ответ модели на основную оценку
  if (!lastAssembly || lastAssembly.status === "failed") {
    return {
      ok: true,
      status: "failed",
      results: lastAssembly?.results ?? [],
      total: null,
      raw: null,
      critical: false,
      model,
      promptVersion: PROMPT_VERSION,
      usage: getUsage(),
      trace: tracker.trace,
      error: lastError,
    };
  }

  tracker.trace.push(`evaluation: ${lastAssembly.status}`);

  // Первый вызов AI Judge
  const cases = input.criteria.map((criterion) => {
    const res = lastAssembly!.results.find((item) => item.criterionId === criterion.id)!;
    return {
      criterion,
      answer: res.answer,
      reason: res.reason,
      naReason: res.naReason,
      evidence: res.evidence.map((item) => ({
        messageIndex: item.messageIndex,
        quote: item.quote,
        speaker: item.speaker ?? "",
        timestampRaw: item.timestampRaw ?? "",
      })),
      checkedRange: res.checkedRange,
    };
  });

  const judgeMessages = [
    { role: "system", content: "Ты AI Judge. Не меняй ответ модели. Верни только JSON verdicts." },
    { role: "user", content: judgePrompt(cases, input.conversation.messages) },
  ];

  const judged = await invokeWithTruncation(tracker, deps, model, judgeMaxTokens, judgeMessages);
  const verdictsMap = new Map<string, SemanticVerdict>();

  if (!judged.ok) {
    tracker.trace.push(`judge error: ${judged.error}`);
    lastAssembly = { ...lastAssembly, status: "needs_review" };
    judgeError = `AI Judge не выполнен: ${judged.error}. Ответ модели не заменён.`;
    return {
      ok: true,
      status: "needs_review",
      results: lastAssembly.results,
      total: lastAssembly.outcome.total,
      raw: lastAssembly.outcome.raw,
      critical: lastAssembly.outcome.critical,
      model,
      promptVersion: PROMPT_VERSION,
      usage: getUsage(),
      trace: tracker.trace,
      error: judgeError,
    };
  }

  try {
    const parsedJudge = parseJudgeResponse(
      extractJson(judged.content),
      input.criteria.map((item) => item.id),
    );
    for (const error of parsedJudge.errors) tracker.trace.push(`judge error: ${error}`);
    for (const verdict of parsedJudge.verdicts) {
      verdictsMap.set(verdict.criterionId, verdict);
    }
  } catch {
    tracker.trace.push("judge error: JSON судьи не разобран");
    lastAssembly = { ...lastAssembly, status: "needs_review" };
    judgeError = "AI Judge вернул неразборный ответ. Оценка модели не заменена.";
    return {
      ok: true,
      status: "needs_review",
      results: lastAssembly.results,
      total: lastAssembly.outcome.total,
      raw: lastAssembly.outcome.raw,
      critical: lastAssembly.outcome.critical,
      model,
      promptVersion: PROMPT_VERSION,
      usage: getUsage(),
      trace: tracker.trace,
      error: judgeError,
    };
  }

  // Применяем вердикты первого вызова судьи
  lastAssembly = applySemanticVerdicts(lastAssembly, [...verdictsMap.values()]);
  tracker.trace.push(
    ...[...verdictsMap.values()].map((item) => `judge ${item.criterionId}: ${item.status}`),
  );

  // Точечный повтор:
  // 1) замечания судьи (invalid или needs_review)
  // 2) критерии, не прошедшие техническую проверку assemble (validationStatus !== "ok")
  const badVerdicts = [...verdictsMap.values()].filter(
    (v) => v.status === "invalid" || v.status === "needs_review",
  );
  const technicalFailedCriteria = input.criteria.filter((c) => {
    const res = lastAssembly!.results.find((r) => r.criterionId === c.id);
    return res && res.validationStatus !== "ok";
  });

  const retryCriterionIds = new Set<string>([
    ...badVerdicts.map((v) => v.criterionId),
    ...technicalFailedCriteria.map((c) => c.id),
  ]);

  if (retryCriterionIds.size > 0) {
    const retryCriteria = input.criteria.filter((c) => retryCriterionIds.has(c.id));
    const judgeNotes = retryCriteria
      .map((c) => {
        const prevRes = lastAssembly!.results.find((r) => r.criterionId === c.id);
        const verdict = verdictsMap.get(c.id);
        const notes: string[] = [];
        if (verdict && (verdict.status === "invalid" || verdict.status === "needs_review")) {
          notes.push(`Замечание судьи (${verdict.status}): ${verdict.explanation}`);
        }
        if (prevRes && prevRes.validationStatus !== "ok") {
          const asmErrors = lastAssembly!.errors.filter((e) => e.startsWith(`${c.id}:`));
          notes.push(
            `Ошибка технической сверки: ${asmErrors.length ? asmErrors.join("; ") : "цитаты или диапазон не подтверждены"}`,
          );
        }
        return `- ${c.id}: прежний ответ ${String(prevRes?.answer)}. ${notes.join(". ")}`;
      })
      .join("\n");

    const pointRetryPrompt = [
      scoringPrompt(retryCriteria, input.conversation),
      "",
      "ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ:",
      "Часть ответов отклонена или требует доработки. Исправь ответы и доказательства только по этим критериям:",
      judgeNotes,
      "",
      "Верни JSON {\"criteria\":[...]} ТОЛЬКО для перечисленных выше критериев.",
    ].join("\n");

    // Дополнительный вызов 1: модель по проблемным критериям
    const pointRetryResult = await invokeWithTruncation(tracker, deps, model, evalMaxTokens, [
      { role: "system", content: system },
      { role: "user", content: pointRetryPrompt },
    ]);

    if (pointRetryResult.ok) {
      try {
        const retryParsed = extractJson(pointRetryResult.content);
        const retryDrafted = draftsFromModelPayload(retryCriteria, retryParsed);
        if (retryDrafted.drafts.length > 0) {
          // Сначала проверяем КАЖДУЮ замену отдельно:
          // Принятой считается замена, у которой при проверке assemble validationStatus === "ok"
          const acceptedDrafts = new Map<string, DraftAnswer>();
          const replacedCriteria: Criterion[] = [];

          for (const c of retryCriteria) {
            const retryDraft = retryDrafted.drafts.find((d) => d.criterionId === c.id);
            if (!retryDraft) continue;

            const singleTestDrafts = currentDrafts.map((d) => (d.criterionId === c.id ? retryDraft : d));
            const singleAssembly = assemble(input.criteria, input.conversation.messages, singleTestDrafts);
            const singleResult = singleAssembly.results.find((r) => r.criterionId === c.id);

            if (singleResult && singleResult.validationStatus === "ok") {
              acceptedDrafts.set(c.id, retryDraft);
              const oldRes = lastAssembly.results.find((r) => r.criterionId === c.id);
              tracker.trace.push(`${c.id}: ${oldRes?.answer} → ${singleResult.answer} после замечания судьи`);
              replacedCriteria.push(c);
            }
          }

          // Пересобираем assemble ТОЛЬКО с принятыми заменами
          if (replacedCriteria.length > 0) {
            currentDrafts = currentDrafts.map((d) => acceptedDrafts.get(d.criterionId) ?? d);
            lastAssembly = assemble(input.criteria, input.conversation.messages, currentDrafts);

            // Дополнительный вызов 2: повторный судья по изменённым критериям
            const rejudgeCases = replacedCriteria.map((criterion) => {
              const res = lastAssembly!.results.find((item) => item.criterionId === criterion.id)!;
              return {
                criterion,
                answer: res.answer,
                reason: res.reason,
                naReason: res.naReason,
                evidence: res.evidence.map((item) => ({
                  messageIndex: item.messageIndex,
                  quote: item.quote,
                  speaker: item.speaker ?? "",
                  timestampRaw: item.timestampRaw ?? "",
                })),
                checkedRange: res.checkedRange,
              };
            });

            const rejudgeResult = await invokeWithTruncation(tracker, deps, model, judgeMaxTokens, [
              { role: "system", content: "Ты AI Judge. Не меняй ответ модели. Верни только JSON verdicts." },
              { role: "user", content: judgePrompt(rejudgeCases, input.conversation.messages) },
            ]);

            if (rejudgeResult.ok) {
              try {
                const parsedRejudge = parseJudgeResponse(
                  extractJson(rejudgeResult.content),
                  replacedCriteria.map((item) => item.id),
                );
                for (const verdict of parsedRejudge.verdicts) {
                  verdictsMap.set(verdict.criterionId, verdict);
                  tracker.trace.push(`rejudge ${verdict.criterionId}: ${verdict.status}`);
                }
              } catch {
                tracker.trace.push("judge error: JSON повторного судьи не разобран");
                judgeError = "AI Judge не выполнен: JSON повторного судьи не разобран. Ответ модели не заменён.";
              }
            } else {
              tracker.trace.push(`judge error: ${rejudgeResult.error}`);
              judgeError = `AI Judge не выполнен: ${rejudgeResult.error}. Ответ модели не заменён.`;
            }
          }

          // Заново применяем все известные вердикты судьи (verdictsMap),
          // чтобы сохранить отметки invalid_evidence у незатронутых критериев
          lastAssembly = applySemanticVerdicts(lastAssembly, [...verdictsMap.values()]);
        }
      } catch {
        tracker.trace.push("retry error: JSON точечного повтора не разобран");
        judgeError = "Точечный повтор не выполнен: JSON точечного повтора не разобран. Ответ модели не заменён.";
      }
    } else {
      tracker.trace.push(`retry error: ${pointRetryResult.error}`);
      judgeError = `Точечный повтор не выполнен: ${pointRetryResult.error}. Ответ модели не заменён.`;
    }
  }

  // Итоговое правило: completed ТОЛЬКО если:
  // (а) статус assemble после всех замен = completed, то есть у всех критериев validationStatus === "ok",
  // И (б) у судьи valid по всем критериям.
  // Судья никогда не повышает статус, только понижает.
  if (lastAssembly.status !== "failed" && lastAssembly.status !== "not_scorable") {
    const assembleOk =
      lastAssembly.status === "completed" &&
      lastAssembly.results.every((r) => r.validationStatus === "ok");
    const judgeOk =
      verdictsMap.size === input.criteria.length &&
      input.criteria.every((c) => verdictsMap.get(c.id)?.status === "valid");

    if (assembleOk && judgeOk) {
      lastAssembly = { ...lastAssembly, status: "completed" };
    } else {
      lastAssembly = { ...lastAssembly, status: "needs_review" };
    }
  }

  return {
    ok: true,
    status: lastAssembly.status,
    results: lastAssembly.results,
    total: lastAssembly.outcome.total,
    raw: lastAssembly.outcome.raw,
    critical: lastAssembly.outcome.critical,
    model,
    promptVersion: PROMPT_VERSION,
    usage: getUsage(),
    trace: tracker.trace,
    error:
      lastAssembly.status === "needs_review"
        ? (judgeError ?? "AI Judge или техническая проверка не подтвердили часть ответов. Баллы модели не переписаны.")
        : undefined,
  };
}
