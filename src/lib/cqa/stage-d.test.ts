import test from "node:test";
import assert from "node:assert/strict";
import { resolveLlmConfig } from "./ai-fns.ts";
import { classifyErrorCode, runEvaluation, type CompleteFn } from "./evaluate-run.ts";
import { runQueue, isFatalQueueError } from "./queue.ts";
import type { Conversation, Criterion } from "./types.ts";
import { MODEL_ID } from "./types.ts";

const dummyConversation: Conversation = {
  id: "conv-1",
  datasetGroupId: "test",
  externalId: "ext-1",
  channel: "chat",
  language: "ru",
  audioUrl: null,
  messages: [
    { messageIndex: 0, timestampRaw: "10:00:00", speaker: "client", text: "Здравствуйте, не могу войти" },
    { messageIndex: 1, timestampRaw: "10:00:05", speaker: "operator", text: "Здравствуйте! Чем могу помочь?" },
  ],
};

const dummyCriteria: Criterion[] = [
  {
    id: "C01",
    title: "Приветствие",
    section: "opening",
    rubric: "Оператор поздоровался",
    weight: 10,
    answerType: "yes_no",
    naAllowed: false,
  },
];

test("Stage D: resolveLlmConfig default values", () => {
  const config = resolveLlmConfig({});
  assert.equal(config.baseUrl, "https://api.x.ai/v1");
  assert.equal(config.apiKey, undefined);
  assert.equal(config.model, MODEL_ID);
  assert.equal(config.isLocal, false);
});

test("Stage D: resolveLlmConfig env priority for API key and model", () => {
  // LLM_API_KEY takes priority over XAI_API_KEY
  const cfg1 = resolveLlmConfig({
    LLM_API_KEY: "llm-key-123",
    XAI_API_KEY: "xai-key-456",
  });
  assert.equal(cfg1.apiKey, "llm-key-123");

  // Fallback to XAI_API_KEY
  const cfg2 = resolveLlmConfig({
    XAI_API_KEY: "xai-key-789",
  });
  assert.equal(cfg2.apiKey, "xai-key-789");

  // LLM_MODEL takes priority over XAI_MODEL
  const cfg3 = resolveLlmConfig({
    LLM_MODEL: "llama3.2:3b",
    XAI_MODEL: "grok-2-1212",
  });
  assert.equal(cfg3.model, "llama3.2:3b");

  // Fallback to XAI_MODEL
  const cfg4 = resolveLlmConfig({
    XAI_MODEL: "grok-beta",
  });
  assert.equal(cfg4.model, "grok-beta");
});

test("Stage D: resolveLlmConfig local endpoints require no API key", () => {
  const localhost = resolveLlmConfig({
    LLM_BASE_URL: "http://localhost:11434/v1",
  });
  assert.equal(localhost.isLocal, true);
  assert.equal(localhost.apiKey, undefined);
  assert.equal(localhost.baseUrl, "http://localhost:11434/v1");

  const ipLocal = resolveLlmConfig({
    LLM_BASE_URL: "http://127.0.0.1:1234/v1/",
  });
  assert.equal(ipLocal.isLocal, true);
  assert.equal(ipLocal.baseUrl, "http://127.0.0.1:1234/v1"); // trailing slash stripped

  const ipv6Local = resolveLlmConfig({
    LLM_BASE_URL: "http://[::1]:8080",
  });
  assert.equal(ipv6Local.isLocal, true);
});

test("Stage D: resolveLlmConfig validates URL protocol and malformed URLs", () => {
  assert.throws(
    () => resolveLlmConfig({ LLM_BASE_URL: "ftp://localhost:11434" }),
    /поддерживаются только протоколы http и https/,
  );

  assert.throws(
    () => resolveLlmConfig({ LLM_BASE_URL: "javascript:alert(1)" }),
    /поддерживаются только протоколы http и https/,
  );

  assert.throws(
    () => resolveLlmConfig({ LLM_BASE_URL: "not-a-valid-url" }),
    /URL не может быть разобран/,
  );
});

test("Stage D: classifyErrorCode classifies HTTP status codes correctly", () => {
  assert.equal(classifyErrorCode(401), "auth");
  assert.equal(classifyErrorCode(403), "auth");
  assert.equal(classifyErrorCode(404), "model_not_found");
  assert.equal(classifyErrorCode(400), "bad_request");
  assert.equal(classifyErrorCode(422), "bad_request");
  assert.equal(classifyErrorCode(429), "transient");
  assert.equal(classifyErrorCode(500), "transient");
  assert.equal(classifyErrorCode(503), "transient");
  assert.equal(classifyErrorCode(undefined), "transient");
  assert.equal(classifyErrorCode(undefined, "no_api_key"), "no_api_key");
  assert.equal(classifyErrorCode(401, "auth"), "auth");
});

test("Stage D: isFatalQueueError detects fatal error codes and flags", () => {
  assert.equal(isFatalQueueError({ code: "no_api_key" }), true);
  assert.equal(isFatalQueueError({ code: "auth" }), true);
  assert.equal(isFatalQueueError({ code: "model_not_found" }), true);
  const err = new Error("auth failed");
  (err as unknown as { fatal: boolean }).fatal = true;
  assert.equal(isFatalQueueError(err), true);

  assert.equal(isFatalQueueError({ code: "transient" }), false);
  assert.equal(isFatalQueueError({ code: "bad_request" }), false);
  assert.equal(isFatalQueueError(new Error("network error")), false);
});

test("Stage D: fatal error stops batch immediately (10 items, first returns fatal)", async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `item-${i + 1}`,
    payload: `conv-${i + 1}`,
  }));

  let workCalls = 0;
  const outcome = await runQueue({
    items,
    concurrency: 2,
    maxAttempts: 3,
    retryDelayMs: 10,
    work: async (payload) => {
      workCalls += 1;
      if (payload === "conv-1") {
        const err = new Error("на сервере нет ключа модели");
        (err as unknown as { code: string; fatal: boolean }).code = "no_api_key";
        (err as unknown as { code: string; fatal: boolean }).fatal = true;
        throw err;
      }
      return "completed";
    },
  });

  // work вызван не более concurrency раз (2)
  assert.ok(workCalls <= 2, `workCalls was ${workCalls}, expected <= 2`);
  assert.equal(outcome.stoppedByFatal, true);
  assert.equal(outcome.fatalCode, "no_api_key");

  // Первый элемент failed с 1 попыткой (без повторов)
  const first = outcome.items[0];
  assert.equal(first.status, "failed");
  assert.equal(first.attempts, 1);

  // Остальные элементы (кроме возможно успевшего запуститься в пределах concurrency) остались pending
  const pendingItems = outcome.items.filter((item) => item.status === "pending");
  assert.ok(pendingItems.length >= 8, `Expected >= 8 pending items, got ${pendingItems.length}`);
});

test("Stage D: auth fatal error stops queue with concurrency 1", async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `item-${i + 1}`,
    payload: `conv-${i + 1}`,
  }));

  let workCalls = 0;
  const outcome = await runQueue({
    items,
    concurrency: 1,
    maxAttempts: 3,
    retryDelayMs: 10,
    work: async () => {
      workCalls += 1;
      const err = new Error("ключ отклонён");
      (err as unknown as { code: string }).code = "auth";
      throw err;
    },
  });

  assert.equal(workCalls, 1);
  assert.equal(outcome.stoppedByFatal, true);
  assert.equal(outcome.fatalCode, "auth");
  assert.equal(outcome.items[0].status, "failed");
  assert.equal(outcome.items[0].attempts, 1);

  // Все 9 оставшихся элементов остались pending
  const pendingItems = outcome.items.filter((item) => item.status === "pending");
  assert.equal(pendingItems.length, 9);
});

test("Stage D: transient errors DO retry up to maxAttempts", async () => {
  let attempts = 0;
  const outcome = await runQueue({
    items: [{ id: "item-1", payload: "conv-1" }],
    concurrency: 1,
    maxAttempts: 3,
    retryDelayMs: 5,
    work: async () => {
      attempts += 1;
      const err = new Error("rate limit 429");
      (err as unknown as { code: string }).code = "transient";
      throw err;
    },
  });

  assert.equal(attempts, 3);
  assert.equal(outcome.stoppedByFatal, false);
  assert.equal(outcome.items[0].status, "failed");
  assert.equal(outcome.items[0].attempts, 3);
});

test("Stage D: runEvaluation returns classified error code on complete failure", async () => {
  const authMockComplete: CompleteFn = async () => ({
    ok: false,
    status: 401,
    code: "auth",
    error: "Unauthorized",
  });

  const resAuth = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    { complete: authMockComplete },
  );

  assert.equal(resAuth.ok, false);
  if (!resAuth.ok) {
    assert.equal(resAuth.code, "auth");
    assert.equal(resAuth.error, "Unauthorized");
  }

  const badReqMockComplete: CompleteFn = async () => ({
    ok: false,
    status: 400,
    error: "Bad Request",
  });

  const resBad = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    { complete: badReqMockComplete },
  );

  assert.equal(resBad.ok, false);
  if (!resBad.ok) {
    assert.equal(resBad.code, "bad_request");
  }
});

test("Stage D: client model regex accepts models with colons, slashes and dots", () => {
  const clientRegex = /^[A-Za-z0-9._:/-]{1,128}$/;
  assert.equal(clientRegex.test("qwen2.5:14b"), true);
  assert.equal(clientRegex.test("llama3.2:3b"), true);
  assert.equal(clientRegex.test("deepseek-r1:7b"), true);
  assert.equal(clientRegex.test("meta-llama/Llama-3.2-3B:latest"), true);
  assert.equal(clientRegex.test("grok-2-latest"), true);
  assert.equal(clientRegex.test(""), false);
  assert.equal(clientRegex.test("bad model name with spaces"), false);
});

test("Stage D: 404 response classifies as model_not_found and stops queue immediately", async () => {
  assert.equal(classifyErrorCode(404), "model_not_found");

  const notFoundMock: CompleteFn = async () => ({
    ok: false,
    status: 404,
    error: "Model not found",
  });

  const evalRes = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    { complete: notFoundMock },
  );
  assert.equal(evalRes.ok, false);
  if (!evalRes.ok) {
    assert.equal(evalRes.code, "model_not_found");
  }

  // Queue stop on 404
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `item-${i + 1}`,
    payload: `conv-${i + 1}`,
  }));

  let workCalls = 0;
  const outcome = await runQueue({
    items,
    concurrency: 2,
    maxAttempts: 3,
    retryDelayMs: 10,
    work: async (payload) => {
      workCalls += 1;
      if (payload === "conv-1") {
        const err = new Error("провайдер не знает модель qwen2.5:14b");
        (err as unknown as { code: string; fatal: boolean }).code = "model_not_found";
        (err as unknown as { code: string; fatal: boolean }).fatal = true;
        throw err;
      }
      return "completed";
    },
  });

  assert.ok(workCalls <= 2, `workCalls was ${workCalls}, expected <= 2`);
  assert.equal(outcome.stoppedByFatal, true);
  assert.equal(outcome.fatalCode, "model_not_found");
  assert.equal(outcome.items[0].status, "failed");
  assert.equal(outcome.items[0].attempts, 1);

  const pendingItems = outcome.items.filter((item) => item.status === "pending");
  assert.ok(pendingItems.length >= 8, `Expected >= 8 pending items, got ${pendingItems.length}`);
});

test("Stage D: timeout defaults to 180000 for localhost and 60000 for cloud, LLM_TIMEOUT_MS overrides", () => {
  const localDefault = resolveLlmConfig({ LLM_BASE_URL: "http://localhost:11434/v1" });
  assert.equal(localDefault.timeoutMs, 180000);

  const ipLocalDefault = resolveLlmConfig({ LLM_BASE_URL: "http://127.0.0.1:8000" });
  assert.equal(ipLocalDefault.timeoutMs, 180000);

  const cloudDefault = resolveLlmConfig({});
  assert.equal(cloudDefault.timeoutMs, 60000);

  const customOverride = resolveLlmConfig({ LLM_TIMEOUT_MS: "45000" });
  assert.equal(customOverride.timeoutMs, 45000);

  const localWithOverride = resolveLlmConfig({
    LLM_BASE_URL: "http://localhost:11434/v1",
    LLM_TIMEOUT_MS: "25000",
  });
  assert.equal(localWithOverride.timeoutMs, 25000);

  // Invalid timeout falls back to default
  const invalidTimeout = resolveLlmConfig({ LLM_TIMEOUT_MS: "not-a-number" });
  assert.equal(invalidTimeout.timeoutMs, 60000);
});

test("Stage D: isLocal results in estimatedCostUsd = 0 with non-zero tokens", async () => {
  const mockSuccessComplete: CompleteFn = async () => ({
    ok: true,
    content: JSON.stringify({
      criteria: [{ id: "C01", answer: "yes", quote: "Здравствуйте! Чем могу помочь?", comment: "Ок" }],
    }),
    promptTokens: 1500,
    completionTokens: 800,
  });

  // Local run: cost should be 0
  const localRes = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    { complete: mockSuccessComplete, isLocal: true },
  );
  assert.equal(localRes.ok, true);
  if (localRes.ok) {
    assert.ok(localRes.usage.promptTokens > 0);
    assert.ok(localRes.usage.completionTokens > 0);
    assert.equal(localRes.usage.estimatedCostUsd, 0);
  }

  // Cloud run: cost should be > 0
  const cloudRes = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    { complete: mockSuccessComplete, isLocal: false },
  );
  assert.equal(cloudRes.ok, true);
  if (cloudRes.ok) {
    assert.ok(cloudRes.usage.promptTokens > 0);
    assert.ok(cloudRes.usage.completionTokens > 0);
    assert.ok(cloudRes.usage.estimatedCostUsd > 0);
  }
});

test("Stage D: LLM_PRICE_*=0 results in estimatedCostUsd = 0 with non-zero tokens", async () => {
  const mockSuccessComplete: CompleteFn = async () => ({
    ok: true,
    content: JSON.stringify({
      criteria: [{ id: "C01", answer: "yes", quote: "Здравствуйте! Чем могу помочь?", comment: "Ок" }],
    }),
    promptTokens: 1500,
    completionTokens: 800,
  });

  const cfg = resolveLlmConfig({
    LLM_PRICE_INPUT_PER_M: "0",
    LLM_PRICE_OUTPUT_PER_M: "0",
  });
  assert.equal(cfg.priceSource, "env");
  assert.equal(cfg.priceInputPerM, 0);
  assert.equal(cfg.priceOutputPerM, 0);

  const res = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    {
      complete: mockSuccessComplete,
      isLocal: false,
      priceInputPerM: cfg.priceInputPerM,
      priceOutputPerM: cfg.priceOutputPerM,
    },
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.ok(res.usage.promptTokens > 0);
    assert.ok(res.usage.completionTokens > 0);
    assert.equal(res.usage.estimatedCostUsd, 0);
  }
});

test("Stage D: specified LLM_PRICE_* values are applied in cost calculation", async () => {
  const mockSuccessComplete: CompleteFn = async () => ({
    ok: true,
    content: JSON.stringify({
      criteria: [{ id: "C01", answer: "yes", quote: "Здравствуйте! Чем могу помочь?", comment: "Ок" }],
    }),
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  });

  const cfg = resolveLlmConfig({
    LLM_PRICE_INPUT_PER_M: "10",
    LLM_PRICE_OUTPUT_PER_M: "30",
  });
  assert.equal(cfg.priceSource, "env");
  assert.equal(cfg.priceInputPerM, 10);
  assert.equal(cfg.priceOutputPerM, 30);

  const res = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    {
      complete: mockSuccessComplete,
      isLocal: false,
      priceInputPerM: cfg.priceInputPerM,
      priceOutputPerM: cfg.priceOutputPerM,
    },
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    const expected = (res.usage.promptTokens / 1_000_000) * 10 + (res.usage.completionTokens / 1_000_000) * 30;
    assert.equal(res.usage.estimatedCostUsd, Math.round(expected * 10_000) / 10_000);
  }
});

test("Stage D: garbage LLM_PRICE_* values fall back to default types.ts prices", async () => {
  const cfg = resolveLlmConfig({
    LLM_PRICE_INPUT_PER_M: "not-a-number",
    LLM_PRICE_OUTPUT_PER_M: "-10",
  });
  assert.equal(cfg.priceSource, "default");
  assert.equal(cfg.priceInputPerM, 2);
  assert.equal(cfg.priceOutputPerM, 6);

  const mockSuccessComplete: CompleteFn = async () => ({
    ok: true,
    content: JSON.stringify({
      criteria: [{ id: "C01", answer: "yes", quote: "Здравствуйте! Чем могу помочь?", comment: "Ок" }],
    }),
    promptTokens: 1000,
    completionTokens: 500,
  });

  const res = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    {
      complete: mockSuccessComplete,
      isLocal: false,
      priceInputPerM: cfg.priceInputPerM,
      priceOutputPerM: cfg.priceOutputPerM,
    },
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    const expected = (res.usage.promptTokens / 1_000_000) * 2 + (res.usage.completionTokens / 1_000_000) * 6;
    assert.equal(res.usage.estimatedCostUsd, Math.round(expected * 10_000) / 10_000);
  }

  // Also verify that omitting price deps falls back to default prices
  const resDefault = await runEvaluation(
    { conversation: dummyConversation, criteria: dummyCriteria },
    {
      complete: mockSuccessComplete,
      isLocal: false,
    },
  );
  assert.equal(resDefault.ok, true);
  if (resDefault.ok) {
    const expected = (resDefault.usage.promptTokens / 1_000_000) * 2 + (resDefault.usage.completionTokens / 1_000_000) * 6;
    assert.equal(resDefault.usage.estimatedCostUsd, Math.round(expected * 10_000) / 10_000);
  }
});

test("Stage D: priceSource is correctly reported for env, default and local", () => {
  // Case 1: default (no price env vars, not local)
  const defaultCfg = resolveLlmConfig({});
  assert.equal(defaultCfg.priceSource, "default");
  assert.equal(defaultCfg.priceInputPerM, 2);
  assert.equal(defaultCfg.priceOutputPerM, 6);

  // Case 2: env (prices specified in env)
  const envCfg1 = resolveLlmConfig({ LLM_PRICE_INPUT_PER_M: "0", LLM_PRICE_OUTPUT_PER_M: "0" });
  assert.equal(envCfg1.priceSource, "env");
  assert.equal(envCfg1.priceInputPerM, 0);
  assert.equal(envCfg1.priceOutputPerM, 0);

  const envCfg2 = resolveLlmConfig({ LLM_PRICE_INPUT_PER_M: "5.5" });
  assert.equal(envCfg2.priceSource, "env");
  assert.equal(envCfg2.priceInputPerM, 5.5);
  assert.equal(envCfg2.priceOutputPerM, 6); // default output price kept

  // Case 3: local (localhost / 127.0.0.1 overrides env prices to local and 0)
  const localCfg = resolveLlmConfig({
    LLM_BASE_URL: "http://localhost:11434/v1",
    LLM_PRICE_INPUT_PER_M: "100",
  });
  assert.equal(localCfg.priceSource, "local");
  assert.equal(localCfg.priceInputPerM, 0);
  assert.equal(localCfg.priceOutputPerM, 0);
});
