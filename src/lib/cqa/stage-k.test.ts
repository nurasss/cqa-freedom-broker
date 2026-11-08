import test from "node:test";
import assert from "node:assert/strict";
import { allowedAnswers, answerAllowed, validateChecklist } from "./score.ts";
import { rulesDrafts } from "./rules.ts";
import { assemble } from "./engine.ts";
import { materialize } from "./store.ts";
import { resultRows, resultsToCsv } from "./benchmark.ts";
import { canStartBatch, isCostCapValid } from "./queue.ts";
import { officialVersion } from "./seed.ts";
import type {
  Appeal,
  Conversation,
  Criterion,
  Evaluation,
  ReviewDecision,
} from "./types.ts";

// -------------------------------------------------------------
// 1. N/A ПРИ СНЯТОЙ ГАЛОЧКЕ
// -------------------------------------------------------------
test("Stage K - 1.1: allowedAnswers strictly checks naAllowed for yes_no_na", () => {
  const critWithNa: Criterion = {
    id: "T01",
    title: "Test with N/A",
    rubric: "Rubric",
    weight: 10,
    answerType: "yes_no_na",
    naAllowed: true,
    section: "opening",
  };
  assert.deepEqual(allowedAnswers(critWithNa), ["yes", "no", "na"]);
  assert.equal(answerAllowed(critWithNa, "na"), true);

  const critWithoutNa: Criterion = {
    ...critWithNa,
    naAllowed: false,
  };
  assert.deepEqual(allowedAnswers(critWithoutNa), ["yes", "no"]);
  assert.equal(answerAllowed(critWithoutNa, "na"), false);
});

test("Stage K - 1.2: validateChecklist detects yes_no_na without naAllowed and invalid naAllowed on yes_no/flag", () => {
  const invalidYesNoNa: Criterion[] = [
    {
      id: "C01",
      title: "Title",
      rubric: "Rubric",
      weight: 10,
      answerType: "yes_no_na",
      naAllowed: false,
      section: "opening",
    },
  ];
  const errs1 = validateChecklist(invalidYesNoNa);
  assert.ok(
    errs1.some((msg) => msg.includes("C01: тип yes_no_na требует N/A, выберите yes_no")),
    `Expected error about yes_no_na requiring N/A, got: ${errs1.join("; ")}`,
  );

  const invalidYesNo: Criterion[] = [
    {
      id: "C02",
      title: "Title",
      rubric: "Rubric",
      weight: 10,
      answerType: "yes_no",
      naAllowed: true,
      section: "opening",
    },
  ];
  const errs2 = validateChecklist(invalidYesNo);
  assert.ok(
    errs2.some((msg) => msg.includes("C02: N/A запрещён для этого типа")),
    `Expected error about N/A forbidden, got: ${errs2.join("; ")}`,
  );

  const invalidFlag: Criterion[] = [
    {
      id: "C08",
      title: "Flag",
      rubric: "Rubric",
      weight: 0,
      answerType: "flag",
      naAllowed: true,
      section: "safety_resolution",
    },
  ];
  const errs3 = validateChecklist(invalidFlag);
  assert.ok(
    errs3.some((msg) => msg.includes("C08: N/A запрещён для этого типа")),
    `Expected error about N/A forbidden for flag, got: ${errs3.join("; ")}`,
  );
});

test("Stage K - 1.3: rulesDrafts and assemble reject na when naAllowed is false", () => {
  const conv: Conversation = {
    id: "conv-k1",
    datasetGroupId: "test",
    externalId: "ext-k1",
    channel: "chat",
    language: "ru",
    audioUrl: null,
    messages: [
      { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "AAPL тариф 1000000 withdraw" },
      { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Здравствуйте" },
    ],
  };

  // C02 naturally evaluates to "na" when data was sufficient.
  // If naAllowed is turned off, rulesDrafts must return "no" instead of "na".
  const critC02NoNa: Criterion = {
    ...officialVersion().criteria.find((c) => c.id === "C02")!,
    naAllowed: false,
  };
  const drafts = rulesDrafts([critC02NoNa], conv);
  assert.equal(drafts[0]?.answer, "no", "Heuristic must fall back to 'no' when naAllowed is false");

  // If a draft somehow still contains "na" for a criterion with naAllowed=false,
  // assemble must reject it as invalid answer schema.
  const assembled = assemble(
    [critC02NoNa],
    conv.messages,
    [
      {
        criterionId: "C02",
        answer: "na",
        reason: "Полнота с начала",
        quotes: [],
        checkedRange: null,
        naReason: "Хватало с начала",
      },
    ],
  );
  assert.equal(assembled.status, "failed");
  assert.ok(
    assembled.errors.some((err) => err.includes("C02: недопустимый ответ")),
    `Expected invalid answer error, got: ${assembled.errors.join("; ")}`,
  );
});

// -------------------------------------------------------------
// 2. ФЛАГ C08 ПОСЛЕ АПЕЛЛЯЦИИ
// -------------------------------------------------------------
test("Stage K - 2: C08 critical flag behavior in materialize", () => {
  const version = officialVersion();
  const allResults = version.criteria.map((c) => ({
    criterionId: c.id,
    answer: c.id === "C04" ? 10 : c.id === "C08" ? ("yes" as const) : c.answerType === "scale" ? 10 : ("yes" as const),
    reason: "Тестовая причина",
    evidence: [],
    checkedRange: null,
    naReason: null,
    validationStatus: c.id === "C08" ? ("invalid_evidence" as const) : ("ok" as const),
    weight: c.weight,
    normalized: 1,
    contribution: c.weight,
    isNa: false,
    critical: false,
  }));

  const baseEvaluation: Evaluation = {
    id: "eval-k2",
    conversationId: "conv-k2",
    checklistVersionId: version.id,
    configHash: version.configHash,
    model: "test-model",
    promptVersion: "cqa-s5-v5",
    source: "ai",
    status: "needs_review",
    startedAt: "2026-11-08T10:00:00Z",
    createdAt: "2026-11-08T10:00:01Z",
    baseTotal: 70,
    finalTotal: 70,
    baseRaw: 70,
    finalRaw: 70,
    baseCritical: false,
    finalCritical: false,
    usage: null,
    trace: [],
    baseResults: allResults,
    finalResults: [],
  };

  // (a) C08=yes invalid, decision on C04 -> finalCritical: false
  const appealC04: Appeal = {
    id: "appeal-c04",
    evaluationId: baseEvaluation.id,
    criterionId: "C04",
    comment: "Ответ был полным",
    status: "overridden",
    createdAt: "2026-11-08T10:05:00Z",
  };
  const decisionC04: ReviewDecision = {
    id: "dec-c04",
    appealId: appealC04.id,
    action: "overridden",
    oldAnswer: 10,
    newAnswer: 20,
    reason: "Ревьюер согласился: ответ полный",
    createdAt: "2026-11-08T10:06:00Z",
  };

  const matA = materialize(baseEvaluation, version, [appealC04], [decisionC04]);
  assert.equal(
    matA.finalCritical,
    false,
    "Case (a): Appeal decision on C04 must NOT activate invalid C08 flag",
  );
  const c08ResA = matA.finalResults.find((r) => r.criterionId === "C08");
  assert.equal(c08ResA?.critical, false);

  // (b) C08=yes invalid, reviewer confirmed C08 -> finalCritical: true
  const appealC08: Appeal = {
    id: "appeal-c08",
    evaluationId: baseEvaluation.id,
    criterionId: "C08",
    comment: "Флаг грубости выставлен верно",
    status: "confirmed",
    createdAt: "2026-11-08T10:07:00Z",
  };
  const decisionC08Confirm: ReviewDecision = {
    id: "dec-c08-conf",
    appealId: appealC08.id,
    action: "confirmed",
    oldAnswer: "yes",
    newAnswer: "yes",
    reason: "Ревьюер подтвердил грубость оператора",
    createdAt: "2026-11-08T10:08:00Z",
  };

  const matB = materialize(baseEvaluation, version, [appealC08], [decisionC08Confirm]);
  assert.equal(
    matB.finalCritical,
    true,
    "Case (b): Reviewer confirmed C08 decision must activate critical flag",
  );
  const c08ResB = matB.finalResults.find((r) => r.criterionId === "C08");
  assert.equal(c08ResB?.critical, true);

  // (c) C08=yes ok (validationStatus: 'ok'), decision on C04 -> finalCritical: true
  const baseEvaluationWithOkC08: Evaluation = {
    ...baseEvaluation,
    baseResults: baseEvaluation.baseResults.map((r) =>
      r.criterionId === "C08" ? { ...r, validationStatus: "ok" as const, critical: true } : r,
    ),
  };
  const matC = materialize(baseEvaluationWithOkC08, version, [appealC04], [decisionC04]);
  assert.equal(
    matC.finalCritical,
    true,
    "Case (c): C08 with validationStatus=ok must remain critical after decision on C04",
  );

  // (d) C08 overridden to "no" -> finalCritical: false
  const decisionC08OverrideNo: ReviewDecision = {
    id: "dec-c08-no",
    appealId: appealC08.id,
    action: "overridden",
    oldAnswer: "yes",
    newAnswer: "no",
    reason: "Ревьюер снял грубость",
    createdAt: "2026-11-08T10:09:00Z",
  };
  const matD = materialize(baseEvaluationWithOkC08, version, [appealC08], [decisionC08OverrideNo]);
  assert.equal(
    matD.finalCritical,
    false,
    "Case (d): C08 overridden to 'no' must clear finalCritical",
  );
  const c08ResD = matD.finalResults.find((r) => r.criterionId === "C08");
  assert.equal(c08ResD?.critical, false);
});

// -------------------------------------------------------------
// 3. ЭКСПОРТ ПО ФИЛЬТРУ
// -------------------------------------------------------------
test("Stage K - 3.1: resultRows with empty conversations returns empty list and CSV has header only", () => {
  const evaluations: Evaluation[] = [
    {
      id: "ev-1",
      conversationId: "conv-1",
      checklistVersionId: "v1",
      configHash: "h1",
      model: "test",
      promptVersion: "cqa-s5-v5",
      source: "heuristic",
      status: "completed",
      startedAt: "2026-11-08T10:00:00Z",
      createdAt: "2026-11-08T10:00:01Z",
      baseTotal: 80,
      finalTotal: 80,
      baseRaw: 80,
      finalRaw: 80,
      baseCritical: false,
      finalCritical: false,
      usage: null,
      trace: [],
      baseResults: [],
      finalResults: [],
    },
  ];

  // In latestOnly mode
  const rowsLatest = resultRows([], evaluations, { latestOnly: true });
  assert.deepEqual(rowsLatest, [], "Empty conversations must yield empty rows (latestOnly=true)");

  // In full mode
  const rowsAll = resultRows([], evaluations, { latestOnly: false });
  assert.deepEqual(rowsAll, [], "Empty conversations must yield empty rows (latestOnly=false)");

  // CSV output
  const csv = resultsToCsv(rowsLatest);
  const lines = csv.replace(/^\uFEFF/, "").trim().split("\n");
  assert.equal(lines.length, 1, "CSV must contain only header line when rows are empty");
  assert.ok(lines[0]!.startsWith("conversationId,externalId,"), "Header must be present");
});

test("Stage K - 3.2: resultRows latestOnly strictly filters by versionId without fallback", () => {
  const conv1: Conversation = {
    id: "conv-1",
    datasetGroupId: "test",
    externalId: "ext-1",
    channel: "chat",
    language: "ru",
    audioUrl: null,
    messages: [],
  };
  const conv2: Conversation = {
    id: "conv-2",
    datasetGroupId: "test",
    externalId: "ext-2",
    channel: "chat",
    language: "ru",
    audioUrl: null,
    messages: [],
  };

  const evaluations: Evaluation[] = [
    // conv1 has evaluation on version v1
    {
      id: "ev-conv1-v1",
      conversationId: "conv-1",
      checklistVersionId: "version-v1",
      configHash: "hash-1",
      model: "test",
      promptVersion: "cqa-s5-v5",
      source: "heuristic",
      status: "completed",
      startedAt: "2026-11-08T10:00:00Z",
      createdAt: "2026-11-08T10:00:01Z",
      baseTotal: 80,
      finalTotal: 80,
      baseRaw: 80,
      finalRaw: 80,
      baseCritical: false,
      finalCritical: false,
      usage: null,
      trace: [],
      baseResults: [],
      finalResults: [],
    },
    // conv2 has evaluation ONLY on version v2
    {
      id: "ev-conv2-v2",
      conversationId: "conv-2",
      checklistVersionId: "version-v2",
      configHash: "hash-2",
      model: "test",
      promptVersion: "cqa-s5-v5",
      source: "heuristic",
      status: "completed",
      startedAt: "2026-11-08T10:01:00Z",
      createdAt: "2026-11-08T10:01:01Z",
      baseTotal: 90,
      finalTotal: 90,
      baseRaw: 90,
      finalRaw: 90,
      baseCritical: false,
      finalCritical: false,
      usage: null,
      trace: [],
      baseResults: [],
      finalResults: [],
    },
  ];

  // Requesting version-v1: conv2 has NO evaluation for version-v1, so it must be excluded!
  const rows = resultRows([conv1, conv2], evaluations, {
    latestOnly: true,
    versionId: "version-v1",
  });

  assert.equal(rows.length, 1, "Only conv1 has evaluation for version-v1");
  assert.equal(rows[0]?.conversationId, "conv-1");
  assert.equal(rows[0]?.checklistVersionId, "version-v1");
});

// -------------------------------------------------------------
// 4. ЗАЩИТА ОТ ПОВТОРНОГО ПАКЕТА ПРИ ПЕРЕХОДЕ МЕЖДУ ЭКРАНАМИ
// -------------------------------------------------------------
test("Stage K - 4: canStartBatch rejects starting another batch when a running job exists", () => {
  assert.equal(canStartBatch([]), true);
  assert.equal(canStartBatch([{ status: "completed" }, { status: "failed" }]), true);
  assert.equal(canStartBatch([{ status: "running" }]), false);
  assert.equal(
    canStartBatch([{ status: "completed" }, { status: "running" }]),
    false,
  );
});

// -------------------------------------------------------------
// 5. ЛИМИТ РАСХОДОВ 0
// -------------------------------------------------------------
test("Stage K - 5: isCostCapValid strictly requires costCap > 0", () => {
  // Invalid values
  assert.equal(isCostCapValid(0), false);
  assert.equal(isCostCapValid(-1), false);
  assert.equal(isCostCapValid(-0.5), false);
  assert.equal(isCostCapValid(""), false);
  assert.equal(isCostCapValid(null), false);
  assert.equal(isCostCapValid(undefined), false);
  assert.equal(isCostCapValid("   "), false);
  assert.equal(isCostCapValid("0"), false);
  assert.equal(isCostCapValid("abc"), false);

  // Valid values
  assert.equal(isCostCapValid(0.01), true);
  assert.equal(isCostCapValid(0.5), true);
  assert.equal(isCostCapValid(5), true);
  assert.equal(isCostCapValid(8), true);
  assert.equal(isCostCapValid("8"), true);
  assert.equal(isCostCapValid("0.05"), true);
});
