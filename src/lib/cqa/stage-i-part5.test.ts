import test from "node:test";
import assert from "node:assert/strict";
import { assemble, type DraftAnswer } from "./engine.ts";
import { applySemanticVerdicts, type SemanticVerdict } from "./semantic-judge.ts";
import { materialize } from "./store.ts";
import {
  evalStatusLabel,
  evalStatusTooltip,
  type ChecklistVersion,
  type Criterion,
  type CriterionResult,
  type Evaluation,
} from "./types.ts";
import { officialCriteria } from "./seed.ts";

test("Stage I.5: evalStatusLabel and evalStatusTooltip return Russian translations and tooltips", () => {
  // Label translations
  assert.equal(evalStatusLabel("completed"), "принято");
  assert.equal(evalStatusLabel("needs_review"), "на проверке");
  assert.equal(evalStatusLabel("failed"), "ошибка");
  assert.equal(evalStatusLabel("not_scorable"), "не рассчитывается");
  assert.equal(evalStatusLabel(null), "—");
  assert.equal(evalStatusLabel(undefined), "—");
  assert.equal(evalStatusLabel("custom_status"), "custom_status");

  // Tooltip descriptions
  assert.equal(evalStatusTooltip("completed"), "принято");
  assert.equal(
    evalStatusTooltip("needs_review"),
    "на проверке: судья или проверка цитат не подтвердили часть ответов",
  );
  assert.equal(evalStatusTooltip("failed"), "ошибка");
  assert.equal(evalStatusTooltip("not_scorable"), "не рассчитывается");
  assert.equal(evalStatusTooltip(null), undefined);
  assert.equal(evalStatusTooltip(undefined), undefined);
  assert.equal(evalStatusTooltip("custom_status"), undefined);
});

test("Stage I.5: assemble preserves evidenceError on invalid_evidence criterion", () => {
  const criteria: Criterion[] = [
    {
      id: "C01",
      section: "opening",
      title: "Приветствие",
      rubric: "Приветствие оператора",
      weight: 10,
      answerType: "yes_no",
      naAllowed: false,
    },
    {
      id: "C02",
      section: "opening",
      title: "Выявление потребности",
      rubric: "Вопрос о проблеме",
      weight: 10,
      answerType: "yes_no",
      naAllowed: false,
    },
  ];

  const messages = [
    { messageIndex: 0, speaker: "client" as const, text: "Здравствуйте!", timestampRaw: "00:01" },
    { messageIndex: 1, speaker: "operator" as const, text: "Добрый день! Чем могу помочь?", timestampRaw: "00:05" },
  ];

  // Draft with a fabricated quote that does not exist in messages
  const drafts: DraftAnswer[] = [
    {
      criterionId: "C01",
      answer: "yes",
      reason: "Оператор поздоровался",
      quotes: [{ messageIndex: 1, quote: "Этой фразы точно нет в транскрипте" }],
      checkedRange: { from: 0, to: 1 },
      naReason: null,
    },
    {
      criterionId: "C02",
      answer: "yes",
      reason: "Нормальное объяснение",
      quotes: [{ messageIndex: 1, quote: "Чем могу помочь?" }],
      checkedRange: { from: 0, to: 1 },
      naReason: null,
    },
  ];

  const assembled = assemble(criteria, messages, drafts);
  const c01 = assembled.results.find((r) => r.criterionId === "C01")!;
  const c02 = assembled.results.find((r) => r.criterionId === "C02")!;

  assert.equal(c01.validationStatus, "invalid_evidence");
  assert.ok(c01.evidenceError, "evidenceError should be populated for invalid quote");
  assert.match(c01.evidenceError!, /цитата не найдена/i);

  assert.equal(c02.validationStatus, "ok");
  assert.equal(c02.evidenceError, undefined);
});

test("Stage I.5: assemble preserves short reason error in evidenceError", () => {
  const criteria: Criterion[] = [
    {
      id: "C02",
      section: "opening",
      title: "Потребность",
      rubric: "Рубрика",
      weight: 10,
      answerType: "yes_no",
      naAllowed: false,
    },
  ];

  const messages = [
    { messageIndex: 0, speaker: "operator" as const, text: "Чем помочь?", timestampRaw: "00:01" },
  ];

  const drafts: DraftAnswer[] = [
    {
      criterionId: "C02",
      answer: "yes",
      reason: "ok", // < 4 chars
      quotes: [],
      checkedRange: { from: 0, to: 0 },
      naReason: null,
    },
  ];

  const assembled = assemble(criteria, messages, drafts);
  const c02 = assembled.results.find((r) => r.criterionId === "C02")!;
  assert.ok(c02.evidenceError);
  assert.match(c02.evidenceError!, /нет объяснения/i);
});

test("Stage I.5: applySemanticVerdicts populates judgeNote on invalid and needs_review criteria", () => {
  const assembled = {
    results: [
      {
        criterionId: "C01",
        answer: "yes" as const,
        reason: "Поздоровался",
        evidence: [{ messageIndex: 0, quote: "Здравствуйте!", speaker: "operator", timestampRaw: "00:01" }],
        checkedRange: { from: 0, to: 0 },
        naReason: null,
        validationStatus: "ok" as const,
        weight: 10,
        normalized: 1,
        contribution: 10,
        isNa: false,
        critical: false,
      },
      {
        criterionId: "C02",
        answer: "yes" as const,
        reason: "Выявил потребность",
        evidence: [{ messageIndex: 0, quote: "Здравствуйте!", speaker: "operator", timestampRaw: "00:01" }],
        checkedRange: { from: 0, to: 0 },
        naReason: null,
        validationStatus: "ok" as const,
        weight: 15,
        normalized: 1,
        contribution: 15,
        isNa: false,
        critical: false,
      },
      {
        criterionId: "C03",
        answer: "yes" as const,
        reason: "Идентификация",
        evidence: [{ messageIndex: 0, quote: "Здравствуйте!", speaker: "operator", timestampRaw: "00:01" }],
        checkedRange: { from: 0, to: 0 },
        naReason: null,
        validationStatus: "ok" as const,
        weight: 10,
        normalized: 1,
        contribution: 10,
        isNa: false,
        critical: false,
      },
    ],
    outcome: {
      status: "ok" as const,
      total: 100,
      raw: 35,
      critical: false,
      denominator: 35,
      lines: [],
      sections: [],
    },
    status: "completed" as const,
    errors: [],
  };

  const verdicts: SemanticVerdict[] = [
    {
      criterionId: "C01",
      status: "invalid",
      explanation: "Цитата содержит приветствие, но оператор не представился по регламенту",
    },
    {
      criterionId: "C02",
      status: "needs_review",
      explanation: "Спорный контекст обращения",
    },
    {
      criterionId: "C03",
      status: "valid",
      explanation: "Идентификация подтверждена",
    },
  ];

  const judged = applySemanticVerdicts(assembled, verdicts);
  assert.equal(judged.status, "needs_review");

  const c01 = judged.results.find((r) => r.criterionId === "C01")!;
  assert.equal(c01.validationStatus, "invalid_evidence");
  assert.equal(c01.judgeNote, "Цитата содержит приветствие, но оператор не представился по регламенту");

  const c02 = judged.results.find((r) => r.criterionId === "C02")!;
  assert.equal(c02.judgeNote, "Спорный контекст обращения");

  const c03 = judged.results.find((r) => r.criterionId === "C03")!;
  assert.equal(c03.validationStatus, "ok");
  assert.equal(c03.judgeNote, undefined);
});

test("Stage I.5: store.ts applyDecision preserves evidenceError and judgeNote in finalResults", () => {
  const version: ChecklistVersion = {
    id: "v1",
    name: "Official",
    versionNumber: 1,
    configHash: "h1",
    label: "v1",
    createdAt: new Date().toISOString(),
    official: true,
    rounding: "HALF_UP",
    criteria: officialCriteria,
  };

  const baseResults: CriterionResult[] = version.criteria.map((c) => ({
    criterionId: c.id,
    answer: c.answerType === "flag" ? "no" : "yes",
    reason: "Обоснование",
    evidence: [],
    checkedRange: null,
    naReason: null,
    validationStatus: c.id === "C01" ? ("invalid_evidence" as const) : ("ok" as const),
    evidenceError: c.id === "C01" ? "C01: цитата не найдена" : undefined,
    judgeNote: c.id === "C01" ? "Замечание судьи по C01" : undefined,
    weight: c.weight,
    normalized: 1,
    contribution: 10,
    isNa: false,
    critical: false,
  }));

  const evaluation: Evaluation = {
    id: "ev-test",
    conversationId: "conv-1",
    checklistVersionId: "v1",
    configHash: "h1",
    model: "grok-4.7",
    promptVersion: "cqa-s5-v5",
    startedAt: new Date().toISOString(),
    source: "ai",
    status: "needs_review",
    createdAt: new Date().toISOString(),
    baseResults,
    finalResults: baseResults,
    baseTotal: 85,
    finalTotal: 85,
    baseRaw: 85,
    finalRaw: 85,
    baseCritical: false,
    finalCritical: false,
    usage: {
      calls: 2,
      promptTokens: 1200,
      completionTokens: 350,
      estimatedCostUsd: 0.0045,
    },
    trace: [],
  };

  const decisions = [
    {
      id: "dec-1",
      appealId: "app-1",
      action: "overridden" as const,
      oldAnswer: "yes" as const,
      newAnswer: "no" as const,
      reason: "Апелляция принята супервайзером",
      createdAt: new Date().toISOString(),
    },
  ];
  const appeals = [
    {
      id: "app-1",
      conversationId: "conv-1",
      criterionId: "C01",
      evaluationId: "ev-test",
      comment: "Спорный вопрос",
      status: "overridden" as const,
      createdAt: new Date().toISOString(),
    },
  ];

  const updated = materialize(evaluation, version, appeals, decisions);
  const updatedC01 = updated.finalResults.find((r) => r.criterionId === "C01")!;

  assert.equal(updatedC01.answer, "no");
  assert.equal(updatedC01.validationStatus, "invalid_evidence");
  assert.equal(updatedC01.evidenceError, "C01: цитата не найдена");
  assert.equal(updatedC01.judgeNote, "Замечание судьи по C01");
});

test("Stage I.5: AI Evaluation structure contains all 5 required metadata fields", () => {
  const evalSample: Evaluation = {
    id: "ev-ai-sample",
    conversationId: "conv-sample",
    checklistVersionId: "official-chat-v1",
    configHash: "hash123",
    model: "grok-4.7",
    promptVersion: "cqa-s5-v5",
    startedAt: new Date().toISOString(),
    source: "ai",
    status: "completed",
    createdAt: new Date().toISOString(),
    baseResults: [],
    finalResults: [],
    baseTotal: 100,
    finalTotal: 100,
    baseRaw: 100,
    finalRaw: 100,
    baseCritical: false,
    finalCritical: false,
    usage: {
      calls: 2,
      promptTokens: 1500,
      completionTokens: 400,
      estimatedCostUsd: 0.0054,
    },
    trace: ["evaluation: completed", "judge: completed"],
  };

  // Check 5 fields
  assert.ok(evalSample.model, "model must be present");
  assert.equal(evalSample.model, "grok-4.7");

  assert.ok(evalSample.promptVersion, "promptVersion must be present");
  assert.equal(evalSample.promptVersion, "cqa-s5-v5");

  assert.ok(evalSample.checklistVersionId, "checklistVersionId must be present");
  assert.equal(evalSample.checklistVersionId, "official-chat-v1");

  assert.ok(typeof evalSample.usage?.calls === "number", "calls must be a number");
  assert.equal(evalSample.usage?.calls, 2);

  assert.ok(typeof evalSample.usage?.estimatedCostUsd === "number", "cost must be a number");
  assert.equal(evalSample.usage?.estimatedCostUsd, 0.0054);
});
