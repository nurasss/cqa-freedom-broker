import assert from "node:assert/strict";
import test from "node:test";
import { runEvaluation, type CompleteFn } from "./evaluate-run.ts";
import { officialCriteria } from "./seed.ts";
import { runQueue } from "./queue.ts";
import { parseImport } from "./engine.ts";
import { resolveCardEvaluation, useCqa } from "./store.ts";
import type { Conversation, Criterion, Evaluation } from "./types.ts";

function testConversation(): Conversation {
  return {
    id: "test-conv-l",
    datasetGroupId: "TEST",
    externalId: "ext-l",
    channel: "agent chat",
    language: "RU",
    audioUrl: null,
    messages: [
      { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте, подскажите комиссию за вывод?" },
      { messageIndex: 1, timestampRaw: "00:04", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Комиссия за вывод составляет 0.3%." },
      { messageIndex: 2, timestampRaw: "00:08", speaker: "client", text: "Спасибо, всё понятно." },
      { messageIndex: 3, timestampRaw: "00:10", speaker: "operator", text: "Пожалуйста, хорошего дня, до свидания!" },
    ],
  };
}

function baseEvalPayload(criteria: Criterion[], overrides: Record<string, { answer: unknown; quote?: string }> = {}): string {
  const list = criteria.map((c) => {
    if (overrides[c.id]) {
      const ov = overrides[c.id]!;
      return {
        criterion_id: c.id,
        answer: ov.answer,
        reason: "Обоснование ответа модели.",
        evidence: ov.quote ? [{ message_index: 1, quote: ov.quote }] : [],
        checked_range: ov.answer === "no" ? { from: 0, to: 3 } : null,
        na_reason: ov.answer === "na" ? "Данных достаточно" : null,
      };
    }
    if (c.id === "C01") {
      return {
        criterion_id: c.id,
        answer: "yes",
        reason: "Оператор поздоровался и представился в первой реплике.",
        evidence: [{ message_index: 1, quote: "Здравствуйте! Меня зовут Айгерим." }],
        checked_range: null,
        na_reason: null,
      };
    }
    if (c.id === "C02") {
      return {
        criterion_id: c.id,
        answer: "na",
        reason: "Вопрос сформулирован полностью, данных хватало.",
        evidence: [],
        checked_range: null,
        na_reason: "Данных для ответа хватало с начала диалога.",
      };
    }
    if (c.id === "C03") {
      return {
        criterion_id: c.id,
        answer: "na",
        reason: "Общий вопрос о тарифах, идентификация не требовалась.",
        evidence: [],
        checked_range: null,
        na_reason: "Запрос не требовал раскрытия защищённых данных.",
      };
    }
    if (c.id === "C04") {
      return {
        criterion_id: c.id,
        answer: 20,
        reason: "Консультация полная и корректная.",
        evidence: [{ message_index: 1, quote: "Комиссия за вывод составляет 0.3%." }],
        checked_range: null,
        na_reason: null,
      };
    }
    if (c.id === "C05") {
      return {
        criterion_id: c.id,
        answer: "yes",
        reason: "Оператор вежлив.",
        evidence: [{ message_index: 1, quote: "Здравствуйте! Меня зовут Айгерим." }],
        checked_range: null,
        na_reason: null,
      };
    }
    if (c.id === "C06") {
      return {
        criterion_id: c.id,
        answer: 10,
        reason: "Речь связная и грамотная.",
        evidence: [{ message_index: 1, quote: "Здравствуйте!" }],
        checked_range: null,
        na_reason: null,
      };
    }
    if (c.id === "C07") {
      return {
        criterion_id: c.id,
        answer: "yes",
        reason: "Оператор вежливо попрощался.",
        evidence: [{ message_index: 3, quote: "до свидания" }],
        checked_range: null,
        na_reason: null,
      };
    }
    return {
      criterion_id: c.id,
      answer: "no",
      reason: "Грубых нарушений не было.",
      evidence: [],
      checked_range: { from: 0, to: 3 },
      na_reason: null,
    };
  });

  return JSON.stringify({ criteria: list });
}

function baseJudgePayload(criteria: Criterion[], overrides: Record<string, { status: "valid" | "invalid" | "needs_review"; explanation: string }> = {}): string {
  const verdicts = criteria.map((c) => {
    if (overrides[c.id]) {
      return {
        criterion_id: c.id,
        status: overrides[c.id]!.status,
        explanation: overrides[c.id]!.explanation,
      };
    }
    return {
      criterion_id: c.id,
      status: "valid",
      explanation: "Сверка подтверждена.",
    };
  });
  return JSON.stringify({ verdicts });
}

// -------------------------------------------------------------
// 1. ПОВТОРНЫЙ СУДЬЯ (evaluate-run.ts)
// -------------------------------------------------------------
test("Stage L - 1a: замена принята, повторный судья вернул ошибку → needs_review", async () => {
  const conv = testConversation();
  let step = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    step++;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));

    if (step === 1) {
      // Исходный ответ: C01 имеет неверную цитату (техническая ошибка validationStatus !== "ok")
      return {
        ok: true,
        content: baseEvalPayload(officialCriteria, {
          C01: { answer: "yes", quote: "Цитата которой нет в диалоге" },
        }),
        promptTokens: 100,
        completionTokens: 100,
      };
    }
    if (step === 2 && isJudge) {
      // Первый судья считает всё valid (включая C01 по смыслу)
      return {
        ok: true,
        content: baseJudgePayload(officialCriteria),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step === 3 && userMsg.includes("ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ")) {
      // Точечный повтор исправляет цитату C01 на корректную
      return {
        ok: true,
        content: JSON.stringify({
          criteria: [
            {
              criterion_id: "C01",
              answer: "yes",
              reason: "Поздоровался и представился",
              evidence: [{ message_index: 1, quote: "Здравствуйте! Меня зовут Айгерим." }],
              checked_range: null,
              na_reason: null,
            },
          ],
        }),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step >= 4 && isJudge) {
      // Повторный судья возвращает ошибку вызова
      return {
        ok: false,
        error: "Сбой сети при повторном судье",
      };
    }
    throw new Error(`Неожиданный шаг ${step}`);
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, true);
  assert.equal(res.status, "needs_review", "При ошибке повторного судьи статус должен быть needs_review");
});

test("Stage L - 1b: повторный судья вернул JSON без вердикта по заменённому критерию → needs_review", async () => {
  const conv = testConversation();
  let step = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    step++;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));

    if (step === 1) {
      return {
        ok: true,
        content: baseEvalPayload(officialCriteria, {
          C01: { answer: "yes", quote: "Цитата которой нет в диалоге" },
        }),
        promptTokens: 100,
        completionTokens: 100,
      };
    }
    if (step === 2 && isJudge) {
      return {
        ok: true,
        content: baseJudgePayload(officialCriteria),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step === 3 && userMsg.includes("ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ")) {
      return {
        ok: true,
        content: JSON.stringify({
          criteria: [
            {
              criterion_id: "C01",
              answer: "yes",
              reason: "Поздоровался и представился",
              evidence: [{ message_index: 1, quote: "Здравствуйте! Меня зовут Айгерим." }],
              checked_range: null,
              na_reason: null,
            },
          ],
        }),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step >= 4 && isJudge) {
      // Повторный судья вернул JSON, но без вердикта по C01
      return {
        ok: true,
        content: JSON.stringify({ verdicts: [] }),
        promptTokens: 30,
        completionTokens: 20,
      };
    }
    throw new Error(`Неожиданный шаг ${step}`);
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, true);
  assert.equal(res.status, "needs_review", "При отсутствии вердикта по заменённому критерию статус должен быть needs_review");
});

test("Stage L - 1c: повторный судья вернул valid → completed", async () => {
  const conv = testConversation();
  let step = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    step++;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));

    if (step === 1) {
      return {
        ok: true,
        content: baseEvalPayload(officialCriteria, {
          C01: { answer: "yes", quote: "Цитата которой нет в диалоге" },
        }),
        promptTokens: 100,
        completionTokens: 100,
      };
    }
    if (step === 2 && isJudge) {
      return {
        ok: true,
        content: baseJudgePayload(officialCriteria),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step === 3 && userMsg.includes("ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ")) {
      return {
        ok: true,
        content: JSON.stringify({
          criteria: [
            {
              criterion_id: "C01",
              answer: "yes",
              reason: "Поздоровался и представился",
              evidence: [{ message_index: 1, quote: "Здравствуйте! Меня зовут Айгерим." }],
              checked_range: null,
              na_reason: null,
            },
          ],
        }),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step >= 4 && isJudge) {
      // Повторный судья подтвердил замену как valid
      return {
        ok: true,
        content: JSON.stringify({
          verdicts: [
            { criterion_id: "C01", status: "valid", explanation: "Цитата и ответ проверены" },
          ],
        }),
        promptTokens: 30,
        completionTokens: 20,
      };
    }
    throw new Error(`Неожиданный шаг ${step}`);
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, true);
  assert.equal(res.status, "completed", "При подтверждении повторным судьёй статус должен быть completed");
});

// -------------------------------------------------------------
// 2. БЮДЖЕТ ПЕРЕД ПОВТОРНОЙ ПОПЫТКОЙ (queue.ts)
// -------------------------------------------------------------
test("Stage L - 2: лимит 0.05, каждая попытка стоит 0.04 и падает → ровно 1 попытка, stoppedByBudget = true", async () => {
  let attemptsCount = 0;

  const outcome = await runQueue({
    items: [{ id: "item-retry-budget", payload: "data" }],
    concurrency: 1,
    maxAttempts: 3,
    retryDelayMs: 0,
    costCap: 0.05,
    estimateCostUsd: 0.04,
    work: async () => {
      attemptsCount++;
      const err = new Error("Попытка завершилась сбоем");
      (err as { costUsd?: number }).costUsd = 0.04;
      throw err;
    },
  });

  assert.ok(attemptsCount >= 1 && attemptsCount <= 2, `Ожидалось 1-2 попытки, факт: ${attemptsCount}`);
  assert.equal(attemptsCount, 1, "При spent=0.04 и estimate=0.04 второй запуск превышает costCap=0.05");
  assert.equal(outcome.stoppedByBudget, true, "stoppedByBudget должно быть true");
  assert.ok(
    outcome.spent !== undefined && outcome.spent <= 0.05 + 0.04,
    `spent (${outcome.spent}) не должен превышать costCap + 1 попытка (0.09)`,
  );
  assert.equal(outcome.items[0]?.status, "failed");
  assert.equal(outcome.items[0]?.message, "Повтор не выполнен: достигнут лимит расходов");
});

// -------------------------------------------------------------
// 3. ПОВРЕЖДЁННЫЕ ФАЙЛЫ (store.ts & engine.ts)
// -------------------------------------------------------------
test("Stage L - 3a: store.importSnapshot отклоняет архив с полем не-массивом без изменения стора", () => {
  const store = useCqa.getState();
  const prevVersionsCount = store.versions.length;
  const prevEvalsCount = store.evaluations.length;

  const err = store.importSnapshot(JSON.stringify({ evaluations: {} }));
  assert.ok(
    err && err.includes("Архив повреждён: поле evaluations не массив"),
    `Ожидалась ошибка поля не-массива, получено: ${err}`,
  );

  const afterStore = useCqa.getState();
  assert.equal(afterStore.versions.length, prevVersionsCount);
  assert.equal(afterStore.evaluations.length, prevEvalsCount);
});

test("Stage L - 3b: engine.parseImport пропускает null и битые записи, добавляя в error сообщение о пропуске", () => {
  const validRecord = {
    conversation_id: "valid-1",
    transcript: [
      { messageIndex: 0, timestamp: "00:01", speaker: "client", text: "Здравствуйте" },
      { messageIndex: 1, timestamp: "00:03", speaker: "operator", text: "Добрый день" },
    ],
  };

  const parsed = parseImport([null, validRecord, { conversation_id: "missing-transcript" }], "TEST");
  assert.equal(parsed.conversations.length, 1);
  assert.equal(parsed.conversations[0]?.externalId, "valid-1");
  assert.ok(
    parsed.error && parsed.error.includes("пропущено 2 повреждённых записей"),
    `Ожидалось сообщение о пропущенных записях в error, получено: ${parsed.error}`,
  );
});

test("Stage L - 3c: store.importSnapshot пропускает битую оценку и импортирует валидную с сообщением", () => {
  const store = useCqa.getState();
  const validEval: Evaluation = {
    id: "ev-valid-l3",
    conversationId: "conv-1",
    checklistVersionId: "official-chat-v1",
    configHash: "h1",
    model: "test",
    promptVersion: "cqa-s5-v5",
    source: "heuristic",
    status: "completed",
    startedAt: "2026-11-08T10:00:00Z",
    createdAt: "2026-11-08T10:00:01Z",
    baseTotal: 85,
    finalTotal: 85,
    baseRaw: 85,
    finalRaw: 85,
    baseCritical: false,
    finalCritical: false,
    usage: null,
    trace: [],
    baseResults: [],
    finalResults: [],
  };

  const corruptedEval = {
    id: "ev-corrupt",
    // missing conversationId and checklistVersionId
  };

  const res = store.importSnapshot(
    JSON.stringify({
      evaluations: [corruptedEval, validEval],
    }),
  );

  assert.ok(
    res && res.includes("Импортировано 1, пропущено 1 повреждённых записей"),
    `Ожидалось информационное сообщение о пропуске, получено: ${res}`,
  );

  const found = useCqa.getState().evaluations.find((e) => e.id === "ev-valid-l3");
  assert.ok(found, "Валидная оценка должна быть импортирована");
});

// -------------------------------------------------------------
// 4. АПЕЛЛЯЦИЯ ОТКРЫВАЕТ СВОЮ ОЦЕНКУ (resolveCardEvaluation)
// -------------------------------------------------------------
test("Stage L - 4: resolveCardEvaluation возвращает указанную evaluationId даже при наличии более новой оценки", () => {
  const evOld: Evaluation = {
    id: "eval-old-target",
    conversationId: "conv-shared",
    checklistVersionId: "version-v1",
    configHash: "h1",
    model: "test",
    promptVersion: "cqa-s5-v5",
    source: "heuristic",
    status: "needs_review",
    startedAt: "2026-11-01T10:00:00Z",
    createdAt: "2026-11-01T10:00:01Z",
    baseTotal: 60,
    finalTotal: 60,
    baseRaw: 60,
    finalRaw: 60,
    baseCritical: false,
    finalCritical: false,
    usage: null,
    trace: [],
    baseResults: [],
    finalResults: [],
  };

  const evNew: Evaluation = {
    id: "eval-new-active",
    conversationId: "conv-shared",
    checklistVersionId: "version-v2",
    configHash: "h2",
    model: "test",
    promptVersion: "cqa-s5-v5",
    source: "ai",
    status: "completed",
    startedAt: "2026-11-08T10:00:00Z",
    createdAt: "2026-11-08T10:00:01Z",
    baseTotal: 95,
    finalTotal: 95,
    baseRaw: 95,
    finalRaw: 95,
    baseCritical: false,
    finalCritical: false,
    usage: null,
    trace: [],
    baseResults: [],
    finalResults: [],
  };

  const evals = [evNew, evOld];

  // При переданном evaluationId возвращается именно evOld
  const chosenOld = resolveCardEvaluation(evals, "conv-shared", "version-v2", "eval-old-target");
  assert.equal(chosenOld?.id, "eval-old-target");
  assert.equal(chosenOld?.checklistVersionId, "version-v1");

  // Без evaluationId возвращается последняя оценка для актуальной версии (evNew)
  const chosenDefault = resolveCardEvaluation(evals, "conv-shared", "version-v2", null);
  assert.equal(chosenDefault?.id, "eval-new-active");
  assert.equal(chosenDefault?.checklistVersionId, "version-v2");
});
