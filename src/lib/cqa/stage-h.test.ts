import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_ID, PROMPT_VERSION } from "./types.ts";
import { officialCriteria } from "./seed.ts";
import { scoringPrompt, judgePrompt } from "./semantic-judge.ts";
import { getGuidanceForCriterion, OFFICIAL_GUIDANCE } from "./guidance.ts";
import { getPauseNote } from "./media.ts";
import { quoteHits } from "./engine.ts";
import { judgeEvidence } from "./evidence.ts";
import { resolveLlmConfig, fetchComplete, readLlmInfo } from "./ai-fns.ts";
import { runEvaluation, type CompleteFn } from "./evaluate-run.ts";
import type { Conversation, Criterion } from "./types.ts";

const dummyConv: Conversation = {
  id: "conv-h",
  datasetGroupId: "test",
  externalId: "ext-h",
  channel: "chat",
  language: "ru",
  audioUrl: null,
  messages: [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте" },
    { messageIndex: 1, timestampRaw: "05:40", speaker: "operator", text: "Здравствуйте! Чем могу помочь?" },
    { messageIndex: 2, timestampRaw: "06:10", speaker: "client", text: "Вопрос по комиссии" },
  ],
};

test("Stage H: PROMPT_VERSION is cqa-s5-v5 and MODEL_ID is grok-4.7", () => {
  assert.equal(PROMPT_VERSION, "cqa-s5-v5");
  assert.equal(MODEL_ID, "grok-4.7");
});

test("Stage H: pause note formatting and detection for MM:SS and ISO", () => {
  // 1. MM:SS >= 60 seconds
  const msg0 = { timestampRaw: "00:08" };
  const msg1 = { timestampRaw: "05:40" }; // diff = 332s = 5:32
  const note1 = getPauseNote(msg1, msg0);
  assert.equal(note1, " (пауза 5:32)");

  // 2. Exact 60 seconds
  const msg60 = { timestampRaw: "01:08" };
  const note60 = getPauseNote(msg60, msg0);
  assert.equal(note60, " (пауза 1:00)");

  // 3. Under 60 seconds -> no pause note
  const msgShort = { timestampRaw: "00:50" }; // diff = 42s
  assert.equal(getPauseNote(msgShort, msg0), "");

  // 4. ISO timestamp >= 60 seconds
  const iso0 = { timestampRaw: "2026-10-15T10:00:00Z" };
  const iso1 = { timestampRaw: "2026-10-15T10:02:15Z" }; // 135s = 2:15
  assert.equal(getPauseNote(iso1, iso0), " (пауза 2:15)");

  // 5. ISO timestamp < 60 seconds
  const isoShort = { timestampRaw: "2026-10-15T10:00:45Z" }; // 45s
  assert.equal(getPauseNote(isoShort, iso0), "");
});

test("Stage H: pause note appears in scoringPrompt and judgePrompt transcripts", () => {
  const prompt = scoringPrompt(officialCriteria, dummyConv);
  // Message 1 has 05:40 vs 00:01 (339 sec = 5:39)
  assert.ok(prompt.includes("[1] 05:40 (пауза 5:39) operator: Здравствуйте! Чем могу помочь?"));
  // Message 2 has 06:10 vs 05:40 (30 sec < 60 sec) -> no pause note
  assert.ok(prompt.includes("[2] 06:10 client: Вопрос по комиссии"));

  const judge = judgePrompt(
    [
      {
        criterion: officialCriteria[0]!,
        answer: "yes",
        reason: "Ок",
        naReason: null,
        evidence: [],
        checkedRange: null,
      },
    ],
    dummyConv.messages,
  );
  assert.ok(judge.includes("[1] 05:40 (пауза 5:39) operator: Здравствуйте! Чем могу помочь?"));
  assert.ok(judge.includes("[2] 06:10 client: Вопрос по комиссии"));
});

test("Stage H: quote copied together with pause note fails quote verification (verified only by text)", () => {
  const targetMessage = dummyConv.messages[1]!; // text: "Здравствуйте! Чем могу помочь?"
  const critC01 = officialCriteria[0]!;

  // Accurate quote passes quoteHits
  assert.equal(quoteHits(targetMessage.text, "Здравствуйте! Чем могу помочь?"), true);

  // Quote that accidentally copies timestamp and pause note fails quoteHits
  const pollutedQuote = "05:40 (пауза 5:39) operator: Здравствуйте! Чем могу помочь?";
  assert.equal(quoteHits(targetMessage.text, pollutedQuote), false);

  // judgeEvidence marks polluted quote invalid
  const judged = judgeEvidence(
    critC01,
    "yes",
    [{ messageIndex: 1, quote: pollutedQuote }],
    { from: 0, to: 2 },
    dummyConv.messages,
  );
  assert.equal(judged.invalid, true);
  assert.ok(judged.errors.some((e) => e.includes("не найдена")));
});

test("Stage H: guidance is present for official C02/C04/C06/C08 and absent when rubric is modified", () => {
  const critC02 = officialCriteria.find((c) => c.id === "C02")!;
  const critC04 = officialCriteria.find((c) => c.id === "C04")!;
  const critC06 = officialCriteria.find((c) => c.id === "C06")!;
  const critC08 = officialCriteria.find((c) => c.id === "C08")!;
  const critC01 = officialCriteria.find((c) => c.id === "C01")!;

  assert.equal(getGuidanceForCriterion(critC02), OFFICIAL_GUIDANCE.C02);
  assert.equal(getGuidanceForCriterion(critC04), OFFICIAL_GUIDANCE.C04);
  assert.equal(getGuidanceForCriterion(critC06), OFFICIAL_GUIDANCE.C06);
  assert.equal(getGuidanceForCriterion(critC08), OFFICIAL_GUIDANCE.C08);
  assert.equal(getGuidanceForCriterion(critC01), null);

  // Modified rubric -> guidance must be absent
  const modifiedC02: Criterion = { ...critC02, rubric: "Новая рубрика C02 для теста" };
  assert.equal(getGuidanceForCriterion(modifiedC02), null);

  // Check presence in scoringPrompt
  const promptOfficial = scoringPrompt(officialCriteria, dummyConv);
  assert.ok(promptOfficial.includes("Методическое уточнение:"));
  assert.ok(promptOfficial.includes(OFFICIAL_GUIDANCE.C02!));
  assert.ok(promptOfficial.includes(OFFICIAL_GUIDANCE.C04!));

  const promptModified = scoringPrompt([modifiedC02], dummyConv);
  assert.ok(!promptModified.includes("Методическое уточнение:"));
  assert.ok(!promptModified.includes(OFFICIAL_GUIDANCE.C02!));
});

test("Stage H: fetchComplete and runEvaluation handle ticks cost (provider) vs token cost with reasoning (estimate)", async () => {
  // Direct fetchComplete test with ticks (provider cost)
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "OK" } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            completion_tokens_details: { reasoning_tokens: 30 },
            cost_in_usd_ticks: 250000000, // 0.025 USD
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const directWithTicks = await fetchComplete("test-key", "https://api.x.ai/v1", "grok-4.7", 100, []);
    assert.equal(directWithTicks.ok, true);
    if (directWithTicks.ok) {
      assert.equal(directWithTicks.reasoningTokens, 30);
      assert.equal(directWithTicks.costSource, "provider");
      assert.equal(directWithTicks.costUsd, 0.025);
    }

    // Direct fetchComplete test without ticks (estimate cost including reasoning)
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "OK" } }],
          usage: {
            prompt_tokens: 1_000_000,
            completion_tokens: 500_000,
            completion_tokens_details: { reasoning_tokens: 500_000 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const directWithoutTicks = await fetchComplete("test-key", "https://api.x.ai/v1", "grok-4.7", 100, []);
    assert.equal(directWithoutTicks.ok, true);
    if (directWithoutTicks.ok) {
      assert.equal(directWithoutTicks.reasoningTokens, 500_000);
      assert.equal(directWithoutTicks.costSource, "estimate");
      // 1M prompt ($2) + (500k completion + 500k reasoning) * $6/M ($6) = $8.0
      assert.equal(directWithoutTicks.costUsd, 8.0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 1. runEvaluation with ticks -> sums costs across calls (scoring + judge = 2 calls)
  const mockWithTicks: CompleteFn = async () => ({
    ok: true,
    content: JSON.stringify({
      criteria: [
        { criterion_id: "C01", answer: "yes", reason: "Поздоровался", evidence: [{ message_index: 1, quote: "Здравствуйте" }] },
      ],
    }),
    promptTokens: 1000,
    completionTokens: 200,
    reasoningTokens: 300,
    costUsd: 0.025,
    costSource: "provider",
  });

  const res1 = await runEvaluation(
    { conversation: dummyConv, criteria: [officialCriteria[0]!] },
    { complete: mockWithTicks },
  );

  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.usage.costSource, "provider");
    // 2 calls * 300 reasoning tokens = 600
    assert.equal(res1.usage.reasoningTokens, 600);
    // 2 calls * 0.025 USD = 0.05 USD
    assert.equal(res1.usage.estimatedCostUsd, 0.05);
  }

  // 2. runEvaluation without ticks -> sums reasoning tokens and calculates cost
  const mockWithoutTicks: CompleteFn = async () => ({
    ok: true,
    content: JSON.stringify({
      criteria: [
        { criterion_id: "C01", answer: "yes", reason: "Поздоровался", evidence: [{ message_index: 1, quote: "Здравствуйте" }] },
      ],
    }),
    promptTokens: 1_000_000,
    completionTokens: 500_000,
    reasoningTokens: 500_000,
  });

  const res2 = await runEvaluation(
    { conversation: dummyConv, criteria: [officialCriteria[0]!] },
    { complete: mockWithoutTicks },
  );

  assert.equal(res2.ok, true);
  if (res2.ok) {
    assert.equal(res2.usage.costSource, "estimate");
    // 2 calls * 500_000 reasoning tokens = 1_000_000
    assert.equal(res2.usage.reasoningTokens, 1_000_000);
    // 2 calls * $8.0 = $16.0
    assert.equal(res2.usage.estimatedCostUsd, 16.0);
  }
});

test("Stage H: resolveLlmConfig defaults reasoning_effort to 'low' for api.x.ai and null for other providers", () => {
  // 1. api.x.ai without LLM_REASONING_EFFORT defaults to "low"
  const xaiConfig = resolveLlmConfig({});
  assert.equal(xaiConfig.reasoningEffort, "low");

  // 2. Other provider (e.g. openrouter.ai) without LLM_REASONING_EFFORT defaults to null
  const openRouterConfig = resolveLlmConfig({ LLM_BASE_URL: "https://openrouter.ai/api/v1" });
  assert.equal(openRouterConfig.reasoningEffort, null);

  // 3. Cloud default timeout is 180000
  assert.equal(xaiConfig.timeoutMs, 180000);
  assert.equal(openRouterConfig.timeoutMs, 180000);
});

test("Stage H: readLlmInfo returns factual reasoningEffort and timeoutMs", () => {
  const info = readLlmInfo({
    LLM_API_KEY: "xai-test",
    LLM_BASE_URL: "https://api.x.ai/v1",
  });
  assert.equal(info.model, "grok-4.7");
  assert.equal(info.reasoningEffort, "low");
  assert.equal(info.timeoutMs, 180000);

  const customInfo = readLlmInfo({
    LLM_API_KEY: "custom-key",
    LLM_BASE_URL: "https://api.openai.com/v1",
    LLM_REASONING_EFFORT: "medium",
    LLM_TIMEOUT_MS: "60000",
  });
  assert.equal(customInfo.reasoningEffort, "medium");
  assert.equal(customInfo.timeoutMs, 60000);
});
