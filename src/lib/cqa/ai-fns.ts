import { createServerFn } from "@tanstack/react-start";
import { assemble, draftsFromModelPayload } from "./engine.ts";
import { applySemanticVerdicts, judgePrompt, parseJudgeResponse, scoringPrompt } from "./semantic-judge.ts";
import type { Conversation, Criterion, CriterionResult, UsageInfo } from "./types.ts";
import { INPUT_USD_PER_M, MODEL_ID, OUTPUT_USD_PER_M, PROMPT_VERSION } from "./types.ts";

interface EvalInput {
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

function estimate(promptTokens: number, completionTokens: number): number {
  const usd = (promptTokens / 1_000_000) * INPUT_USD_PER_M + (completionTokens / 1_000_000) * OUTPUT_USD_PER_M;
  return Math.round(usd * 10_000) / 10_000;
}

function parseContent(content: string): unknown {
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
  return JSON.parse(trimmed);
}

function configuredModel(): string {
  const value = process.env.XAI_MODEL?.trim() ?? "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : MODEL_ID;
}

async function complete(apiKey: string, model: string, maxTokens: number, messages: { role: string; content: string }[]) {
  let lastError = "Сеть xAI недоступна";
  for (let net = 0; net < 2; net++) {
    try {
      const response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(40000),
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages,
        }),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = `xAI ответил ${response.status}`;
        if (net === 0) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        return { ok: false as const, error: lastError };
      }
      if (!response.ok) {
        let detail = "";
        try {
          const body = (await response.json()) as { error?: unknown; code?: unknown };
          const raw = body?.error;
          const message =
            typeof raw === "string"
              ? raw
              : raw && typeof raw === "object" && "message" in raw
                ? String((raw as { message?: unknown }).message ?? "")
                : "";
          const code = typeof body.code === "string" ? (body.code.split(":").pop() ?? "") : "";
          const safeCode = /^[a-z0-9-]{1,40}$/.test(code) ? code : "";
          detail = `${safeCode ? `${safeCode}. ` : ""}${message}`
            .replace(/https?:\/\/\S+/g, "[url]")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180);
        } catch {
          detail = "";
        }
        return { ok: false as const, error: detail ? `xAI ответил ${response.status}: ${detail}` : `xAI ответил ${response.status}` };
      }
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        ok: true as const,
        content: body.choices?.[0]?.message?.content ?? "",
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      };
    } catch {
      lastError = "Таймаут или сеть при вызове модели";
      if (net === 0) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
    }
  }
  return { ok: false as const, error: lastError };
}

export const evaluateConversation = createServerFn({ method: "POST" })
  .validator((input: EvalInput) => {
    if (!input?.conversation?.messages?.length) throw new Error("Пустой диалог");
    if (!input.criteria?.length) throw new Error("Пустой чек-лист");
    if (input.conversation.messages.length > 400) throw new Error("Слишком длинный диалог");
    const requested = input.model?.trim() ?? "";
    if (requested && !/^[A-Za-z0-9._-]{1,64}$/.test(requested)) throw new Error("Некорректное имя модели");
    return input;
  })
  .handler(async ({ data }): Promise<EvalOutput | { ok: false; error: string }> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: "Оценка Grok сейчас недоступна: на сервере нет ключа модели." };
    const requested = data.model?.trim() ?? "";
    const model = /^[A-Za-z0-9._-]{1,64}$/.test(requested) ? requested : configuredModel();

    const system =
      "Ты модуль Conversation Quality Analytics Freedom Broker. Отвечай только JSON по рубрике переданной версии. Итог в баллах не вычисляй.";
    const messages: { role: string; content: string }[] = [
      { role: "system", content: system },
      { role: "user", content: scoringPrompt(data.criteria, data.conversation) },
    ];
    const trace: string[] = [`model ${model}`, `prompt ${PROMPT_VERSION}`];
    let promptTokens = 0;
    let completionTokens = 0;
    let calls = 0;
    let lastError = "Модель не вернула пригодный JSON";
    let lastAssembly: ReturnType<typeof assemble> | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await complete(apiKey, model, 2800, messages);
      calls += 1;
      if (!result.ok) return { ok: false, error: result.error };
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;
      trace.push(`вызов ${calls}: in ${result.promptTokens} / out ${result.completionTokens}`);
      let parsed: unknown;
      try {
        parsed = parseContent(result.content);
      } catch {
        lastError = "JSON модели не разобран";
        messages.push({ role: "assistant", content: result.content.slice(0, 4000) });
        messages.push({ role: "user", content: "Ответ не JSON. Верни полный объект {criteria:[...]} ещё раз, без пояснений." });
        continue;
      }
      const drafted = draftsFromModelPayload(data.criteria, parsed);
      if (drafted.drafts.length !== data.criteria.length) {
        lastError = drafted.errors[0] ?? "Неполный набор критериев";
        messages.push({ role: "assistant", content: result.content.slice(0, 4000) });
        messages.push({
          role: "user",
          content: `Исправь и верни все критерии заново. Ошибки:\n${drafted.errors.join("\n")}`,
        });
        continue;
      }
      const assembled = assemble(data.criteria, data.conversation.messages, drafted.drafts);
      lastAssembly = assembled;
      trace.push(...assembled.errors.slice(0, 6));
      const answerErrors = assembled.errors.filter((error) => /недопустим|Нет |Лишний|Дубль/.test(error));
      if (assembled.status !== "failed" && answerErrors.length === 0 && assembled.status !== "needs_review") {
        break;
      }
      if (attempt === 0 && assembled.status === "needs_review") {
        messages.push({ role: "assistant", content: result.content.slice(0, 4000) });
        messages.push({
          role: "user",
          content: `Цитаты или диапазоны не прошли техническую сверку. Верни полный JSON, quote копируй дословно. Ошибки:\n${assembled.errors.join("\n")}`,
        });
        continue;
      }
      break;
    }

    if (lastAssembly && lastAssembly.status === "completed") {
      trace.push(`evaluation: ${lastAssembly.status}`);
      const cases = data.criteria.map((criterion) => {
        const result = lastAssembly!.results.find((item) => item.criterionId === criterion.id)!;
        return {
          criterion,
          answer: result.answer,
          reason: result.reason,
          naReason: result.naReason,
          evidence: result.evidence.map((item) => ({
            messageIndex: item.messageIndex,
            quote: item.quote,
            speaker: item.speaker ?? "",
            timestampRaw: item.timestampRaw ?? "",
          })),
          checkedRange: result.checkedRange,
        };
      });
      const judged = await complete(apiKey, model, 1200, [
        { role: "system", content: "Ты AI Judge. Не меняй ответ модели. Верни только JSON verdicts." },
        { role: "user", content: judgePrompt(cases, data.conversation.messages) },
      ]);
      calls += 1;
      if (!judged.ok) {
        trace.push(`judge error: ${judged.error}`);
        lastAssembly = { ...lastAssembly, status: "needs_review" };
        lastError = `AI Judge не выполнен: ${judged.error}. Ответ модели не заменён эвристикой.`;
      } else {
        promptTokens += judged.promptTokens;
        completionTokens += judged.completionTokens;
        trace.push(`judge: in ${judged.promptTokens} / out ${judged.completionTokens}`);
        try {
          const parsed = parseJudgeResponse(parseContent(judged.content), data.criteria.map((item) => item.id));
          for (const error of parsed.errors) trace.push(`judge error: ${error}`);
          const before = new Map(lastAssembly.results.map((item) => [item.criterionId, item.answer]));
          lastAssembly = applySemanticVerdicts(lastAssembly, parsed.verdicts);
          for (const result of lastAssembly.results) {
            if (before.get(result.criterionId) !== result.answer) {
              trace.push(`judge error: ${result.criterionId} ответ был изменён и это запрещено`);
            }
          }
          if (lastAssembly.status === "needs_review") lastError = "AI Judge не подтвердил часть ответов. Баллы модели не переписаны.";
          trace.push(
            ...parsed.verdicts.map((item) => `judge ${item.criterionId}: ${item.status}`),
          );
        } catch {
          trace.push("judge error: JSON судьи не разобран");
          lastAssembly = { ...lastAssembly, status: "needs_review" };
          lastError = "AI Judge вернул неразборный ответ. Оценка модели не заменена.";
        }
      }
    } else if (lastAssembly) {
      trace.push(`evaluation: ${lastAssembly.status}`);
      trace.push("judge: пропущен, техническая сверка не прошла");
      lastError = "Техническая сверка цитат не прошла. Ответ модели не заменён эвристикой.";
    }

    const usage: UsageInfo = {
      promptTokens,
      completionTokens,
      estimatedCostUsd: estimate(promptTokens, completionTokens),
      calls,
    };
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
        usage,
        trace,
        error: lastError,
      };
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
      usage,
      trace,
      error: lastAssembly.status === "needs_review" ? lastError : undefined,
    };
  });

export const importOrganizerGroup = createServerFn({ method: "POST" })
  .validator((input: { groupId: string }) => {
    const groupId = input?.groupId?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(groupId)) throw new Error("Некорректный group_id");
    return { groupId };
  })
  .handler(async ({ data }) => {
    const raw = process.env.ORGANIZER_API_URL;
    if (!raw) {
      return {
        ok: false as const,
        error:
          "API организаторов не подключён (нет ORGANIZER_API_URL). Официальный DEV не подменяется демонстрацией. Загрузите JSON или включите адрес на сервере.",
      };
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false as const, error: "Серверный адрес API организаторов некорректен." };
    }
    url.searchParams.set("group_id", data.groupId);
    try {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) return { ok: false as const, error: `API организаторов ответил ${response.status}` };
      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false as const, error: "API организаторов вернул не JSON" };
      }
      if (!payload || typeof payload !== "object") return { ok: false as const, error: "API организаторов вернул не объект" };
      const body = payload as { isSuccess?: boolean; error?: string; data?: { records?: unknown; total_records?: unknown } };
      if (body.isSuccess === false) {
        const message = (typeof body.error === "string" && body.error.trim() ? body.error.trim() : "isSuccess=false").replace(/https?:\/\/\S+/g, "[url]");
        return { ok: false as const, error: `API организаторов: ${message}` };
      }
      if (!body.data || !Array.isArray(body.data.records)) {
        return { ok: false as const, error: "В ответе API нет data.records" };
      }
      return { ok: true as const, bodyText: text };
    } catch {
      return { ok: false as const, error: "Не удалось получить набор: сеть или таймаут." };
    }
  });
