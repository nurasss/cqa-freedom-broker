import { createServerFn } from "@tanstack/react-start";
import {
  runEvaluation,
  type CompleteResult,
  type EvalInput,
  type EvalOutput,
  type EvalResponse,
} from "./evaluate-run.ts";
import { MODEL_ID } from "./types.ts";

export type { EvalInput, EvalOutput, EvalResponse };

function configuredModel(): string {
  const value = process.env.XAI_MODEL?.trim() ?? "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : MODEL_ID;
}

async function fetchComplete(
  apiKey: string,
  model: string,
  maxTokens: number,
  messages: { role: string; content: string }[],
): Promise<CompleteResult> {
  try {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(60000),
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

    if (response.status === 429 || response.status === 408 || response.status >= 500) {
      return {
        ok: false,
        status: response.status,
        retryAfter,
        error: `xAI ответил ${response.status}`,
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
      } catch {
        detail = "";
      }
      return {
        ok: false,
        status: response.status,
        error: detail ? `xAI ответил ${response.status}: ${detail}` : `xAI ответил ${response.status}`,
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
    return { ok: false, error: message };
  }
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
  .handler(async ({ data }): Promise<EvalResponse> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: "Оценка Grok сейчас недоступна: на сервере нет ключа модели." };
    const requested = data.model?.trim() ?? "";
    const model = /^[A-Za-z0-9._-]{1,64}$/.test(requested) ? requested : configuredModel();

    return runEvaluation(
      { ...data, model },
      {
        complete: (mdl, maxTokens, messages) => fetchComplete(apiKey, mdl, maxTokens, messages),
        env: process.env,
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
