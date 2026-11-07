import { createServerFn } from "@tanstack/react-start";
import {
  runEvaluation,
  type CompleteResult,
  type EvalErrorCode,
  type EvalInput,
  type EvalOutput,
  type EvalResponse,
} from "./evaluate-run.ts";
import { INPUT_USD_PER_M, MODEL_ID, OUTPUT_USD_PER_M } from "./types.ts";

export type { CompleteResult, EvalErrorCode, EvalInput, EvalOutput, EvalResponse };

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  isLocal: boolean;
  timeoutMs: number;
  priceInputPerM: number;
  priceOutputPerM: number;
  priceSource: "env" | "default" | "local";
}

export interface LlmInfo {
  model: string;
  provider: string;
  isLocal: boolean;
  hasKey: boolean;
  priceSource: "env" | "default" | "local";
  priceInputPerM?: number;
  priceOutputPerM?: number;
}

export function parsePrice(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return num;
}

export function resolveTimeoutMs(env: Record<string, string | undefined>, isLocal: boolean): number {
  const defaultTimeout = isLocal ? 180000 : 60000;
  const rawTimeout = env.LLM_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const num = Number(rawTimeout);
    if (Number.isFinite(num) && num > 0) {
      return Math.round(num);
    }
  }
  return defaultTimeout;
}

export function resolveLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const rawBaseUrl = env.LLM_BASE_URL?.trim();
  let baseUrl = "https://api.x.ai/v1";
  let isLocal = false;

  if (rawBaseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawBaseUrl);
    } catch {
      throw new Error("Некорректный LLM_BASE_URL: URL не может быть разобран");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Некорректный LLM_BASE_URL: поддерживаются только протоколы http и https");
    }

    const host = parsed.hostname.toLowerCase();
    isLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "0.0.0.0";
    baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
  }

  const apiKey = env.LLM_API_KEY?.trim() || env.XAI_API_KEY?.trim() || undefined;

  const rawModel = env.LLM_MODEL?.trim() || env.XAI_MODEL?.trim() || "";
  const model = /^[A-Za-z0-9._:/-]{1,128}$/.test(rawModel) ? rawModel : MODEL_ID;
  const timeoutMs = resolveTimeoutMs(env, isLocal);

  const parsedInputPrice = parsePrice(env.LLM_PRICE_INPUT_PER_M);
  const parsedOutputPrice = parsePrice(env.LLM_PRICE_OUTPUT_PER_M);
  const hasEnvPrice = parsedInputPrice !== undefined || parsedOutputPrice !== undefined;

  let priceSource: "env" | "default" | "local";
  let priceInputPerM: number;
  let priceOutputPerM: number;

  if (isLocal) {
    priceSource = "local";
    priceInputPerM = 0;
    priceOutputPerM = 0;
  } else if (hasEnvPrice) {
    priceSource = "env";
    priceInputPerM = parsedInputPrice !== undefined ? parsedInputPrice : INPUT_USD_PER_M;
    priceOutputPerM = parsedOutputPrice !== undefined ? parsedOutputPrice : OUTPUT_USD_PER_M;
  } else {
    priceSource = "default";
    priceInputPerM = INPUT_USD_PER_M;
    priceOutputPerM = OUTPUT_USD_PER_M;
  }

  return {
    baseUrl,
    apiKey,
    model,
    isLocal,
    timeoutMs,
    priceInputPerM,
    priceOutputPerM,
    priceSource,
  };
}

export async function fetchComplete(
  apiKey: string | undefined,
  baseUrl: string,
  model: string,
  maxTokens: number,
  messages: { role: string; content: string }[],
  timeoutMs = 60000,
): Promise<CompleteResult> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages,
      }),
    });

    const retryAfterHeader = response.headers.get("retry-after");
    let retryAfter: number | undefined;
    if (retryAfterHeader) {
      const parsedSeconds = Number(retryAfterHeader);
      if (!Number.isNaN(parsedSeconds) && parsedSeconds > 0) {
        retryAfter = parsedSeconds;
      }
    }

    if (response.status === 404) {
      return {
        ok: false,
        status: 404,
        code: "model_not_found",
        error: `Провайдер LLM ответил 404: модель ${model} не найдена или неверный endpoint`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        code: "auth",
        error: `Провайдер LLM ответил ${response.status}: ошибка аутентификации`,
      };
    }

    if (response.status === 429 || response.status === 408 || response.status >= 500) {
      return {
        ok: false,
        status: response.status,
        code: "transient",
        retryAfter,
        error: `Провайдер LLM ответил ${response.status}`,
      };
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
        if (apiKey && apiKey.length > 4) {
          detail = detail.replaceAll(apiKey, "[REDACTED]");
        }
      } catch {
        detail = "";
      }

      const isBadRequest = response.status === 400 || response.status === 422;
      const code: EvalErrorCode = isBadRequest ? "bad_request" : "transient";
      return {
        ok: false,
        status: response.status,
        code,
        error: detail ? `Провайдер LLM ответил ${response.status}: ${detail}` : `Провайдер LLM ответил ${response.status}`,
      };
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      ok: true,
      content: body.choices?.[0]?.message?.content ?? "",
      finishReason: body.choices?.[0]?.finish_reason ?? null,
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    const message = isTimeout
      ? "Таймаут или сеть при вызове модели (таймаут)"
      : "Таймаут или сеть при вызове модели";
    return { ok: false, code: "transient", error: message };
  }
}

export const getLlmInfo = createServerFn({ method: "GET" })
  .handler(async (): Promise<LlmInfo> => {
    try {
      const config = resolveLlmConfig(process.env);
      let provider = "unknown";
      try {
        provider = new URL(config.baseUrl).hostname;
      } catch {
        provider = config.baseUrl;
      }
      return {
        model: config.model,
        provider,
        isLocal: config.isLocal,
        hasKey: Boolean(config.apiKey),
        priceSource: config.priceSource,
        priceInputPerM: config.priceInputPerM,
        priceOutputPerM: config.priceOutputPerM,
      };
    } catch {
      return {
        model: MODEL_ID,
        provider: "api.x.ai",
        isLocal: false,
        hasKey: false,
        priceSource: "default",
        priceInputPerM: INPUT_USD_PER_M,
        priceOutputPerM: OUTPUT_USD_PER_M,
      };
    }
  });

export const evaluateConversation = createServerFn({ method: "POST" })
  .validator((input: EvalInput) => {
    if (!input?.conversation?.messages?.length) throw new Error("Пустой диалог");
    if (!input.criteria?.length) throw new Error("Пустой чек-лист");
    if (input.conversation.messages.length > 400) throw new Error("Слишком длинный диалог");
    const requested = input.model?.trim() ?? "";
    if (requested && !/^[A-Za-z0-9._:/-]{1,128}$/.test(requested)) throw new Error("Некорректное имя модели");
    return input;
  })
  .handler(async ({ data }): Promise<EvalResponse> => {
    let config: LlmConfig;
    try {
      config = resolveLlmConfig(process.env);
    } catch (err) {
      return {
        ok: false,
        code: "bad_request",
        error: err instanceof Error ? err.message : "Некорректная конфигурация LLM",
      };
    }

    if (!config.apiKey && !config.isLocal) {
      return {
        ok: false,
        code: "no_api_key",
        error: "Оценка Grok сейчас недоступна: на сервере нет ключа модели.",
      };
    }

    const requested = data.model?.trim() ?? "";
    const model = /^[A-Za-z0-9._:/-]{1,128}$/.test(requested) ? requested : config.model;

    return runEvaluation(
      { ...data, model },
      {
        complete: (mdl, maxTokens, messages) =>
          fetchComplete(config.apiKey, config.baseUrl, mdl, maxTokens, messages, config.timeoutMs),
        env: process.env,
        isLocal: config.isLocal,
        priceInputPerM: config.priceInputPerM,
        priceOutputPerM: config.priceOutputPerM,
      },
    );
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
