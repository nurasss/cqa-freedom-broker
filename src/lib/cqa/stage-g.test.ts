import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestBody,
  parseReasoningEffort,
  resolveLlmConfig,
  fetchComplete,
} from "./ai-fns.ts";
import {
  classifyErrorCode,
  runEvaluation,
  type CompleteFn,
} from "./evaluate-run.ts";
import { runQueue, isFatalQueueError } from "./queue.ts";
import { controlConversations } from "./control.ts";
import { filterConversations } from "./store.ts";
import type { Conversation, Criterion } from "./types.ts";

const dummyConversation: Conversation = {
  id: "conv-1",
  datasetGroupId: "test",
  externalId: "ext-1",
  channel: "chat",
  language: "ru",
  audioUrl: null,
  messages: [
    { messageIndex: 0, timestampRaw: "10:00:00", speaker: "client", text: "Здравствуйте, не могу войти" },
    { messageIndex: 1, timestampRaw: "10:00:05", speaker: "operator", text: "Здравствуйте, меня зовут Анна! Чем могу помочь?" },
  ],
};

const dummyCriteria: Criterion[] = [
  {
    id: "C01",
    title: "Приветствие",
    section: "opening",
    rubric: "Оператор поздоровался и представился",
    weight: 10,
    answerType: "yes_no",
    naAllowed: false,
  },
];

test("Stage G: dynamic study dialogs count matches controlConversations().length (34)", () => {
  const list = controlConversations();
  assert.equal(list.length, 34);
});

test("Stage G: parseReasoningEffort parses valid values and rejects invalid", () => {
  assert.equal(parseReasoningEffort("none"), "none");
  assert.equal(parseReasoningEffort("LOW"), "low");
  assert.equal(parseReasoningEffort("Medium"), "medium");
  assert.equal(parseReasoningEffort("HIGH"), "high");

  assert.equal(parseReasoningEffort(undefined), null);
  assert.equal(parseReasoningEffort(""), null);
  assert.equal(parseReasoningEffort("ultra"), null);
  assert.equal(parseReasoningEffort("123"), null);
});

test("Stage G: resolveLlmConfig correctly parses LLM_REASONING_EFFORT", () => {
  const cfg1 = resolveLlmConfig({ LLM_REASONING_EFFORT: "low" });
  assert.equal(cfg1.reasoningEffort, "low");

  const cfg2 = resolveLlmConfig({ LLM_REASONING_EFFORT: "high" });
  assert.equal(cfg2.reasoningEffort, "high");

  const cfg3 = resolveLlmConfig({ LLM_REASONING_EFFORT: "invalid" });
  assert.equal(cfg3.reasoningEffort, null);

  const cfg4 = resolveLlmConfig({ LLM_BASE_URL: "https://openrouter.ai/api/v1" });
  assert.equal(cfg4.reasoningEffort, null);

  // xAI defaults to "low" when unset
  const cfgXAi = resolveLlmConfig({});
  assert.equal(cfgXAi.reasoningEffort, "low");
});

test("Stage G: buildRequestBody includes reasoning_effort only when set", () => {
  const messages = [{ role: "user", content: "Привет" }];

  const bodyWithEffort = buildRequestBody("gemini-2.5-flash", 1000, messages, "low");
  assert.equal(bodyWithEffort.model, "gemini-2.5-flash");
  assert.equal(bodyWithEffort.max_tokens, 1000);
  assert.equal(bodyWithEffort.reasoning_effort, "low");

  const bodyNull = buildRequestBody("grok-4.5", 2000, messages, null);
  assert.equal(bodyNull.reasoning_effort, undefined);
  assert.ok(!("reasoning_effort" in bodyNull));

  const bodyUndefined = buildRequestBody("grok-4.5", 2000, messages);
  assert.equal(bodyUndefined.reasoning_effort, undefined);
  assert.ok(!("reasoning_effort" in bodyUndefined));
});

test("Stage G: classifyErrorCode distinguishes Gemini 400 API key error from generic 400", () => {
  // Gemini 400 API key error
  assert.equal(
    classifyErrorCode(400, undefined, "API key not valid. Please pass a valid API key."),
    "auth",
  );
  assert.equal(
    classifyErrorCode(400, undefined, "INVALID_ARGUMENT: API_KEY_INVALID"),
    "auth",
  );
  assert.equal(
    classifyErrorCode(400, "auth"),
    "auth",
  );

  // Generic 400 error (e.g., bad json schema, missing field)
  assert.equal(
    classifyErrorCode(400, undefined, "Invalid JSON schema in request"),
    "bad_request",
  );
  assert.equal(
    classifyErrorCode(400),
    "bad_request",
  );
  assert.equal(
    classifyErrorCode(422),
    "bad_request",
  );

  // Standard status codes
  assert.equal(classifyErrorCode(401), "auth");
  assert.equal(classifyErrorCode(403), "auth");
  assert.equal(classifyErrorCode(404), "model_not_found");
  assert.equal(classifyErrorCode(500), "transient");
});

test("Stage G: fetchComplete classifies 400 with API key error as 'auth' and redacts key", async () => {
  const secretKey = "AIzaSySecretApiKey123456789";

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            message: `API key not valid. Please pass a valid API key. Key used: ${secretKey}`,
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await fetchComplete(
      secretKey,
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "gemini-2.5-flash",
      1000,
      [{ role: "user", content: "test" }],
      5000,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "auth");
      assert.equal(result.status, 400);
      assert.ok(!result.error.includes(secretKey), "API key must be redacted");
      assert.ok(result.error.includes("[REDACTED]"));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage G: fetchComplete keeps generic 400 as 'bad_request'", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Field 'messages' contains invalid role 'moderator'",
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await fetchComplete(
      "some-key",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "gemini-2.5-flash",
      1000,
      [{ role: "user", content: "test" }],
      5000,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "bad_request");
      assert.equal(result.status, 400);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage G: runEvaluation and queue stop immediately on Gemini 400 API key error (no infinite loop)", async () => {
  let callCount = 0;
  const mockGeminiComplete: CompleteFn = async () => {
    callCount += 1;
    return {
      ok: false,
      status: 400,
      code: "auth",
      error: "Провайдер LLM ответил 400: API key not valid. Please pass a valid API key.",
    };
  };

  const evalRes = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    { complete: mockGeminiComplete },
  );

  assert.equal(evalRes.ok, false);
  if (!evalRes.ok) {
    assert.equal(evalRes.code, "auth");
  }
  // No retry attempts on auth failure: single call made
  assert.equal(callCount, 1);

  // Now test queue execution with 5 items:
  // When an item fails with code: "auth", isFatalQueueError must trigger and abort the remaining items
  const items = [
    { id: "c1", payload: dummyConversation },
    { id: "c2", payload: dummyConversation },
    { id: "c3", payload: dummyConversation },
    { id: "c4", payload: dummyConversation },
    { id: "c5", payload: dummyConversation },
  ];

  let queueCalls = 0;
  const outcome = await runQueue({
    items,
    concurrency: 1,
    maxAttempts: 3,
    retryDelayMs: 0,
    work: async (conv) => {
      queueCalls += 1;
      const res = await runEvaluation(
        { conversation: conv, criteria: dummyCriteria },
        { complete: mockGeminiComplete },
      );
      if (!res.ok) {
        const err = new Error(res.error);
        if (res.code) {
          (err as { code?: string }).code = res.code;
        }
        if (isFatalQueueError(err)) {
          (err as { fatal?: boolean }).fatal = true;
        }
        throw err;
      }
      return "completed";
    },
  });

  assert.equal(outcome.stoppedByFatal, true);
  assert.equal(outcome.fatalCode, "auth");
  // Only the first item ran, rest 4 were aborted
  assert.equal(queueCalls, 1);
  assert.equal(outcome.completed, 0);
  assert.equal(outcome.failed, 1);
});

test("Stage G: filterConversations filters by group, language combination, and 'all'", () => {
  const dataset: Conversation[] = [
    { ...dummyConversation, id: "c1", datasetGroupId: "DEMO", language: "RU", channel: "agent chat" },
    { ...dummyConversation, id: "c2", datasetGroupId: "DEMO", language: "KZ", channel: "agent chat" },
    { ...dummyConversation, id: "c3", datasetGroupId: "STUDY", language: "RU", channel: "agent chat" },
    { ...dummyConversation, id: "c4", datasetGroupId: "STUDY", language: "EN", channel: "voice call" },
    { ...dummyConversation, id: "c5", datasetGroupId: "CTRL-TEST", language: "RU", channel: "voice call" },
    { ...dummyConversation, id: "c6", datasetGroupId: "CTRL-TEST", language: "KZ", channel: "agent chat" },
  ];

  // 1. Фильтр по группе
  const ctrlOnly = filterConversations(dataset, { group: "CTRL-TEST", language: "all", channel: "all" });
  assert.equal(ctrlOnly.length, 2);
  assert.deepEqual(ctrlOnly.map((c) => c.id), ["c5", "c6"]);

  const studyOnly = filterConversations(dataset, { group: "STUDY", language: "all", channel: "all" });
  assert.equal(studyOnly.length, 2);
  assert.deepEqual(studyOnly.map((c) => c.id), ["c3", "c4"]);

  // 2. Сочетание группы с языком
  const studyRu = filterConversations(dataset, { group: "STUDY", language: "RU", channel: "all" });
  assert.equal(studyRu.length, 1);
  assert.equal(studyRu[0]?.id, "c3");

  const ctrlKz = filterConversations(dataset, { group: "CTRL-TEST", language: "KZ", channel: "all" });
  assert.equal(ctrlKz.length, 1);
  assert.equal(ctrlKz[0]?.id, "c6");

  const ctrlEn = filterConversations(dataset, { group: "CTRL-TEST", language: "EN", channel: "all" });
  assert.equal(ctrlEn.length, 0);

  // 3. Сочетание группы, языка и канала
  const ctrlRuVoice = filterConversations(dataset, { group: "CTRL-TEST", language: "RU", channel: "voice call" });
  assert.equal(ctrlRuVoice.length, 1);
  assert.equal(ctrlRuVoice[0]?.id, "c5");

  // 4. "Все" (all) возвращает весь список без фильтрации
  const allResult = filterConversations(dataset, { group: "all", language: "all", channel: "all" });
  assert.equal(allResult.length, 6);
  assert.deepEqual(allResult.map((c) => c.id), ["c1", "c2", "c3", "c4", "c5", "c6"]);

  // Без параметров или с пустым объектом тоже возвращает всё
  const defaultResult = filterConversations(dataset);
  assert.equal(defaultResult.length, 6);
});
