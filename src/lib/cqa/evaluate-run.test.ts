import assert from "node:assert/strict";
import test from "node:test";
import { extractJson, parseTokenLimit, runEvaluation, type CompleteFn } from "./evaluate-run.ts";
import { officialCriteria } from "./seed.ts";
import type { Conversation, Criterion } from "./types.ts";

function testConversation(): Conversation {
  return {
    id: "test-conv-1",
    datasetGroupId: "TEST",
    externalId: "ext-1",
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

function validEvalPayload(criteria: Criterion[], overrides: Record<string, { answer: unknown; quote?: string }> = {}): string {
  const list = criteria.map((c) => {
    if (overrides[c.id]) {
      const ov = overrides[c.id]!;
      return {
        criterion_id: c.id,
        answer: ov.answer,
        reason: "Обоснование ответа модели в тестах.",
        evidence: ov.quote ? [{ message_index: 1, quote: ov.quote }] : [],
        checked_range: ov.answer === "no" ? { from: 0, to: 1 } : null,
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
    if (c.id === "C08") {
      return {
        criterion_id: c.id,
        answer: "no",
        reason: "Грубых нарушений не было.",
        evidence: [],
        checked_range: { from: 0, to: 3 },
        na_reason: null,
      };
    }
    return {
      criterion_id: c.id,
      answer: "no",
      reason: "Тестовый ответ",
      evidence: [],
      checked_range: { from: 0, to: 3 },
      na_reason: null,
    };
  });

  return JSON.stringify({ criteria: list });
}

function validJudgePayload(criteria: Criterion[], overrides: Record<string, { status: "valid" | "invalid" | "needs_review"; explanation: string }> = {}): string {
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
      explanation: "Ответ и доказательства полностью согласуются с рубрикой.",
    };
  });
  return JSON.stringify({ verdicts });
}

test("1. обрезка, затем успех", async () => {
  const conv = testConversation();
  const calls: { model: string; maxTokens: number }[] = [];

  const completeMock: CompleteFn = async (model, maxTokens) => {
    calls.push({ model, maxTokens });
    if (calls.length === 1) {
      // Первый вызов завершается по length (обрезка)
      return {
        ok: true,
        content: '{"criteria":[{"criterion_id":"C01"',
        finishReason: "length",
        promptTokens: 100,
        completionTokens: 50,
      };
    }
    if (calls.length === 2) {
      // Повтор с удвоенным maxTokens
      return {
        ok: true,
        content: validEvalPayload(officialCriteria),
        finishReason: "stop",
        promptTokens: 100,
        completionTokens: 200,
      };
    }
    // Вызов AI Judge
    return {
      ok: true,
      content: validJudgePayload(officialCriteria),
      finishReason: "stop",
      promptTokens: 80,
      completionTokens: 40,
    };
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.status, "completed");
    assert.ok(res.trace.includes("truncated"), "В trace должна быть запись truncated");
    assert.equal(calls[0]!.maxTokens, 6000);
    assert.equal(calls[1]!.maxTokens, 12000, "При обрезке max_tokens должен удвоиться");
    assert.equal(res.usage.calls, 3);
    assert.equal(res.usage.promptTokens, 280);
    assert.equal(res.usage.completionTokens, 290);
  }
});

test("2. JSON в markdown и с текстом вокруг", async () => {
  const conv = testConversation();
  const rawWithMarkdown = `Вот подробная оценка диалога в формате JSON:
\`\`\`json
${validEvalPayload(officialCriteria)}
\`\`\`
Надеюсь, эта оценка вам поможет!`;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));
    if (isJudge) {
      return {
        ok: true,
        content: `\`\`\`json\n${validJudgePayload(officialCriteria)}\n\`\`\``,
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    return {
      ok: true,
      content: rawWithMarkdown,
      promptTokens: 150,
      completionTokens: 250,
    };
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.status, "completed");
    assert.equal(res.results.length, officialCriteria.length);
  }

  // Также проверяем саму функцию extractJson
  const parsed = extractJson(rawWithMarkdown) as { criteria: unknown[] };
  assert.ok(Array.isArray(parsed.criteria));
});

test("3. 429, затем успех", async () => {
  const conv = testConversation();
  let attempt = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    attempt++;
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));
    if (attempt === 1) {
      return {
        ok: false,
        status: 429,
        retryAfter: 1,
        error: "xAI ответил 429: Too Many Requests",
      };
    }
    if (isJudge) {
      return {
        ok: true,
        content: validJudgePayload(officialCriteria),
        promptTokens: 40,
        completionTokens: 30,
      };
    }
    return {
      ok: true,
      content: validEvalPayload(officialCriteria),
      promptTokens: 120,
      completionTokens: 180,
    };
  };

  let sleptMs = 0;
  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    {
      complete: completeMock,
      sleep: async (ms) => {
        sleptMs += ms;
      },
    },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.status, "completed");
    assert.equal(res.usage.calls, 3); // 1 неуспешный (429) + 1 успешная оценка + 1 судья
    assert.ok(sleptMs > 0, "Должна быть задержка перед повтором при 429");
  }
});

test("4. сбой судьи по сети → ok:true, needs_review, результаты модели сохранены, usage включает вызов судьи", async () => {
  const conv = testConversation();
  let callNum = 0;

  const completeMock: CompleteFn = async () => {
    callNum++;
    if (callNum === 1) {
      return {
        ok: true,
        content: validEvalPayload(officialCriteria),
        promptTokens: 150,
        completionTokens: 90,
      };
    }
    // Второй вызов (судья) завершается сетевой ошибкой
    return {
      ok: false,
      error: "Сетевой таймаут при вызове AI Judge",
    };
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.status, "needs_review");
    assert.equal(res.results.length, officialCriteria.length);
    assert.match(res.error ?? "", /AI Judge не выполнен/);
    assert.ok(res.trace.some((t) => t.includes("judge error: Сетевой таймаут при вызове AI Judge")));
    assert.ok(res.usage.calls >= 2);
    assert.equal(res.usage.promptTokens, 150);
    assert.equal(res.usage.completionTokens, 90);
  }
});

test("5. судья пометил C04 invalid, повтор исправил → completed", async () => {
  const conv = testConversation();
  let step = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    step++;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));

    if (step === 1) {
      // 1. Первая оценка: C04 = 10
      return {
        ok: true,
        content: validEvalPayload(officialCriteria, {
          C04: { answer: 10, quote: "Комиссия за вывод составляет 0.3%." },
        }),
        promptTokens: 100,
        completionTokens: 100,
      };
    }
    if (step === 2 && isJudge) {
      // 2. Первый судья: помечает C04 как invalid
      return {
        ok: true,
        content: validJudgePayload(officialCriteria, {
          C04: { status: "invalid", explanation: "Консультация полная, комиссия названа верно, должно быть 20." },
        }),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step === 3 && userMsg.includes("ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ")) {
      // 3. Точечный повтор модели: исправляет C04 на 20
      return {
        ok: true,
        content: JSON.stringify({
          criteria: [
            {
              criterion_id: "C04",
              answer: 20,
              reason: "После замечания судьи: консультация полная.",
              evidence: [{ message_index: 1, quote: "Комиссия за вывод составляет 0.3%." }],
              checked_range: null,
              na_reason: null,
            },
          ],
        }),
        promptTokens: 40,
        completionTokens: 30,
      };
    }
    if (step === 4 && isJudge) {
      // 4. Повторный судья по C04: возвращает valid
      return {
        ok: true,
        content: JSON.stringify({
          verdicts: [
            {
              criterion_id: "C04",
              status: "valid",
              explanation: "Теперь оценка 20 согласована с рубрикой.",
            },
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
  if (res.ok) {
    assert.equal(res.status, "completed");
    const c04 = res.results.find((r) => r.criterionId === "C04");
    assert.equal(c04?.answer, 20);
    assert.ok(
      res.trace.some((t) => t.includes("C04: 10 → 20 после замечания судьи")),
      "В trace должна быть запись о замене балла C04",
    );
  }
});

test("6. повтор не исправил → needs_review, исходный ответ сохранён", async () => {
  const conv = testConversation();
  let step = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    step++;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));

    if (step === 1) {
      // 1. Первая оценка: C04 = 10
      return {
        ok: true,
        content: validEvalPayload(officialCriteria, {
          C04: { answer: 10, quote: "Комиссия за вывод составляет 0.3%." },
        }),
        promptTokens: 100,
        completionTokens: 100,
      };
    }
    if (step === 2 && isJudge) {
      // 2. Судья помечает C04 как invalid
      return {
        ok: true,
        content: validJudgePayload(officialCriteria, {
          C04: { status: "invalid", explanation: "Не согласен с оценкой 10." },
        }),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step === 3 && userMsg.includes("ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ")) {
      // 3. Точечный повтор модели возвращает некорректную цитату (техническая сверка assemble не пройдёт)
      return {
        ok: true,
        content: JSON.stringify({
          criteria: [
            {
              criterion_id: "C04",
              answer: 20,
              reason: "Пытаюсь исправить",
              evidence: [{ message_index: 99, quote: "Несуществующая цитата" }],
              checked_range: null,
              na_reason: null,
            },
          ],
        }),
        promptTokens: 40,
        completionTokens: 30,
      };
    }

    throw new Error(`Неожиданный шаг ${step}`);
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.status, "needs_review");
    const c04 = res.results.find((r) => r.criterionId === "C04");
    assert.equal(c04?.answer, 10, "Исходный ответ 10 должен быть сохранён");
  }
});

test("7. не больше двух дополнительных вызовов на оценку", async () => {
  const conv = testConversation();
  let totalCalls = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    totalCalls++;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));

    if (totalCalls === 1) {
      return {
        ok: true,
        content: validEvalPayload(officialCriteria, {
          C04: { answer: 10, quote: "Комиссия за вывод составляет 0.3%." },
        }),
        promptTokens: 100,
        completionTokens: 100,
      };
    }
    if (totalCalls === 2 && isJudge) {
      return {
        ok: true,
        content: validJudgePayload(officialCriteria, {
          C04: { status: "invalid", explanation: "Требуется исправление" },
        }),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (totalCalls === 3 && userMsg.includes("ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ")) {
      // Дополнительный вызов 1 (модель)
      return {
        ok: true,
        content: JSON.stringify({
          criteria: [
            {
              criterion_id: "C04",
              answer: 15,
              reason: "Исправление",
              evidence: [{ message_index: 1, quote: "Комиссия за вывод составляет 0.3%." }],
              checked_range: null,
              na_reason: null,
            },
          ],
        }),
        promptTokens: 40,
        completionTokens: 30,
      };
    }
    if (totalCalls === 4 && isJudge) {
      // Дополнительный вызов 2 (судья)
      return {
        ok: true,
        content: JSON.stringify({
          verdicts: [{ criterion_id: "C04", status: "needs_review", explanation: "Всё ещё есть сомнения" }],
        }),
        promptTokens: 30,
        completionTokens: 20,
      };
    }

    throw new Error(`Превышено число вызовов: ${totalCalls}`);
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, true);
  // Всего базовых вызовов = 2 (оценка + судья). Дополнительных вызовов = 2 (повтор модели + повтор судьи).
  assert.equal(totalCalls, 4, "Всего должно быть 4 вызова (2 базовых + не больше 2 дополнительных)");
});

test("8. проверка токен-лимитов env XAI_MAX_TOKENS и XAI_JUDGE_MAX_TOKENS", () => {
  assert.equal(parseTokenLimit(undefined, 6000), 6000);
  assert.equal(parseTokenLimit("", 6000), 6000);
  assert.equal(parseTokenLimit("invalid", 6000), 6000);
  assert.equal(parseTokenLimit("-5", 6000), 6000);
  assert.equal(parseTokenLimit("0", 6000), 6000);
  assert.equal(parseTokenLimit("8500", 6000), 8500);
  assert.equal(parseTokenLimit("4000", 3000), 4000);
});

test("9. полный прогон runEvaluation: клиент поздоровался, оператор нет, модель дала C01=yes с цитатой клиента, судья вернул valid по всем → статус НЕ completed; точечный повтор вызван для C01", async () => {
  const conv: Conversation = {
    id: "test-conv-c01-client",
    datasetGroupId: "TEST",
    externalId: "ext-c01",
    channel: "agent chat",
    language: "RU",
    audioUrl: null,
    messages: [
      { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте!" },
      { messageIndex: 1, timestampRaw: "00:04", speaker: "operator", text: "Комиссия за вывод составляет 0.3%." },
      { messageIndex: 2, timestampRaw: "00:08", speaker: "client", text: "Спасибо, всё понятно." },
      { messageIndex: 3, timestampRaw: "00:10", speaker: "operator", text: "До свидания!" },
    ],
  };

  let pointRetryCalledForC01 = false;
  let pointRetryHadAssembleError = false;
  let step = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    step++;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));

    if (step === 1) {
      // 1. Модель возвращает C01=yes с цитатой клиента (messageIndex 0)
      return {
        ok: true,
        content: validEvalPayload(officialCriteria, {
          C01: { answer: "yes", quote: "Здравствуйте!" },
        }),
        promptTokens: 120,
        completionTokens: 100,
      };
    }
    if (step === 2 && isJudge) {
      // 2. Судья ошибочно возвращает valid по всем критериям
      return {
        ok: true,
        content: validJudgePayload(officialCriteria),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step === 3 && userMsg.includes("ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ")) {
      // 3. Точечный повтор: проверяем, что он вызван для C01 и содержит ошибку assemble
      if (userMsg.includes("C01")) {
        pointRetryCalledForC01 = true;
      }
      if (userMsg.includes("Ошибка технической сверки") || userMsg.includes("цитата client не подтверждает")) {
        pointRetryHadAssembleError = true;
      }
      // Модель в повторе не смогла исправить (снова возвращает C01=yes с цитатой клиента)
      return {
        ok: true,
        content: JSON.stringify({
          criteria: [
            {
              criterion_id: "C01",
              answer: "yes",
              reason: "Клиент поздоровался",
              evidence: [{ message_index: 0, quote: "Здравствуйте!" }],
              checked_range: null,
              na_reason: null,
            },
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
  if (res.ok) {
    assert.equal(res.status, "needs_review", "Статус должен быть needs_review, а НЕ completed");
    assert.notEqual(res.status, "completed");
    assert.ok(pointRetryCalledForC01, "Точечный повтор должен быть вызван для C01");
    assert.ok(pointRetryHadAssembleError, "В замечании должна быть ошибка технической сверки");
    assert.ok(!res.error?.includes("пригодный JSON"), "error не должен содержать 'пригодный JSON'");
    assert.match(res.error ?? "", /AI Judge или техническая проверка не подтвердили/);
  }
});

test("10. сетевая ошибка (без status), затем успех → оценка проходит, calls учитывает повтор", async () => {
  const conv = testConversation();
  let calls = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    calls++;
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));
    if (calls === 1) {
      // Ошибка без status (например, Network error или таймаут из fetchComplete)
      return {
        ok: false,
        error: "Таймаут или сеть при вызове модели",
      };
    }
    if (isJudge) {
      return {
        ok: true,
        content: validJudgePayload(officialCriteria),
        promptTokens: 40,
        completionTokens: 30,
      };
    }
    return {
      ok: true,
      content: validEvalPayload(officialCriteria),
      promptTokens: 100,
      completionTokens: 100,
    };
  };

  let slept = false;
  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    {
      complete: completeMock,
      sleep: async () => {
        slept = true;
      },
    },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.status, "completed");
    assert.equal(res.usage.calls, 3); // 1-й сбой без статуса + 2-й успешная оценка + 3-й судья
    assert.ok(slept, "При сетевой ошибке должен вызываться sleep");
  }
});

test("11. 401 → без повторов", async () => {
  const conv = testConversation();
  let calls = 0;

  const completeMock: CompleteFn = async () => {
    calls++;
    return {
      ok: false,
      status: 401,
      error: "xAI ответил 401: Incorrect API key",
    };
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, false);
  assert.equal(calls, 1, "При 401 не должно быть повторных попыток");
  if (!res.ok) {
    assert.equal(res.usage?.calls, 1);
  }
});

test("12. точечный повтор вернул два ответа, один прошёл проверку, второй нет → в итоге принятый новый и СТАРЫЙ для второго; trace содержит строку замены только для принятого", async () => {
  const conv = testConversation();
  let step = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    step++;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));

    if (step === 1) {
      // 1. Основная оценка: C04 = 10, C05 = "no"
      return {
        ok: true,
        content: validEvalPayload(officialCriteria, {
          C04: { answer: 10, quote: "Комиссия за вывод составляет 0.3%." },
          C05: { answer: "no" },
        }),
        promptTokens: 120,
        completionTokens: 100,
      };
    }
    if (step === 2 && isJudge) {
      // 2. Судья помечает и C04, и C05 как invalid
      return {
        ok: true,
        content: validJudgePayload(officialCriteria, {
          C04: { status: "invalid", explanation: "Консультация полная, должно быть 20." },
          C05: { status: "invalid", explanation: "Оператор был вежлив, должно быть yes." },
        }),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step === 3 && userMsg.includes("ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ")) {
      // 3. Точечный повтор возвращает 2 ответа: C04 валидный (20), C05 невалидный (цитата с неверным message_index)
      return {
        ok: true,
        content: JSON.stringify({
          criteria: [
            {
              criterion_id: "C04",
              answer: 20,
              reason: "Консультация полная.",
              evidence: [{ message_index: 1, quote: "Комиссия за вывод составляет 0.3%." }],
              checked_range: null,
              na_reason: null,
            },
            {
              criterion_id: "C05",
              answer: "yes",
              reason: "Оператор вежлив.",
              evidence: [{ message_index: 99, quote: "Несуществующая цитата" }],
              checked_range: null,
              na_reason: null,
            },
          ],
        }),
        promptTokens: 40,
        completionTokens: 30,
      };
    }
    if (step === 4 && isJudge) {
      // 4. Повторный судья вызывается только для принятого C04
      return {
        ok: true,
        content: JSON.stringify({
          verdicts: [
            {
              criterion_id: "C04",
              status: "valid",
              explanation: "20 подтверждено.",
            },
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
  if (res.ok) {
    const c04 = res.results.find((r) => r.criterionId === "C04");
    const c05 = res.results.find((r) => r.criterionId === "C05");
    assert.equal(c04?.answer, 20, "Принятый ответ C04 должен стать 20");
    assert.equal(c05?.answer, "no", "Отклонённый ответ C05 должен остаться прежним ('no')");

    assert.ok(
      res.trace.some((t) => t.includes("C04: 10 → 20 после замечания судьи")),
      "В trace должна быть строка замены для принятого C04",
    );
    assert.ok(
      !res.trace.some((t) => t.includes("C05: no → yes после замечания судьи")),
      "В trace НЕ должно быть строки замены для отклонённого C05",
    );
  }
});

test("13. повторный судья упал → отметка invalid_evidence первого судьи у незатронутого критерия сохранилась", async () => {
  const conv = testConversation();
  let step = 0;

  const completeMock: CompleteFn = async (_model, _maxTokens, messages) => {
    step++;
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const isJudge = messages.some((m) => m.content.includes("AI Judge"));

    if (step === 1) {
      // 1. Модель возвращает C04 = 10, C06 = 0
      return {
        ok: true,
        content: validEvalPayload(officialCriteria, {
          C04: { answer: 10, quote: "Комиссия за вывод составляет 0.3%." },
          C06: { answer: 0, quote: "Здравствуйте!" },
        }),
        promptTokens: 120,
        completionTokens: 100,
      };
    }
    if (step === 2 && isJudge) {
      // 2. Первый судья: помечает C04 invalid и C06 invalid
      return {
        ok: true,
        content: validJudgePayload(officialCriteria, {
          C04: { status: "invalid", explanation: "Консультация полная, нужно 20." },
          C06: { status: "invalid", explanation: "Речь вежливая, снижение до 0 необоснованно." },
        }),
        promptTokens: 50,
        completionTokens: 50,
      };
    }
    if (step === 3 && userMsg.includes("ЗАМЕЧАНИЯ AI JUDGE ПО ЭТИМ КРИТЕРИЯМ")) {
      // 3. Точечный повтор возвращает исправление ТОЛЬКО для C04 (C06 остался не затронут моделью)
      return {
        ok: true,
        content: JSON.stringify({
          criteria: [
            {
              criterion_id: "C04",
              answer: 20,
              reason: "Консультация полная.",
              evidence: [{ message_index: 1, quote: "Комиссия за вывод составляет 0.3%." }],
              checked_range: null,
              na_reason: null,
            },
          ],
        }),
        promptTokens: 40,
        completionTokens: 30,
      };
    }
    if (step >= 4 && isJudge) {
      // 4. Повторный судья по C04 падает (сетевой сбой)
      return {
        ok: false,
        error: "Сетевой сбой при повторном судье",
      };
    }

    throw new Error(`Неожиданный шаг ${step}`);
  };

  const res = await runEvaluation(
    { conversation: conv, criteria: officialCriteria },
    { complete: completeMock, sleep: async () => {} },
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.status, "needs_review");
    const c06 = res.results.find((r) => r.criterionId === "C06");
    assert.equal(
      c06?.validationStatus,
      "invalid_evidence",
      "У незатронутого C06 должна сохраниться отметка invalid_evidence от первого судьи",
    );
    assert.ok(
      res.trace.some((t) => t.includes("judge error: Сетевой сбой при повторном судье")),
      "В trace должна быть запись об ошибке повторного судьи",
    );
  }
});
