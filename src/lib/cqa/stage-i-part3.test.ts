import test from "node:test";
import assert from "node:assert/strict";
import {
  csvCell,
  formatCheckedRange,
  formatEvidenceQuotes,
  resultRows,
  resultsToCsv,
  UTF8_BOM,
} from "./benchmark.ts";
import type { Conversation, CriterionResult, Evaluation } from "./types.ts";

function createMockConversation(
  id: string,
  datasetGroupId: string,
  externalId: string,
  language = "RU",
  channel = "chat",
): Conversation {
  return {
    id,
    datasetGroupId,
    externalId,
    channel,
    language,
    audioUrl: null,
    origin: "organizer",
    messages: [
      { messageIndex: 0, speaker: "client", text: "Здравствуйте!", timestampRaw: "00:01" },
      { messageIndex: 1, speaker: "operator", text: "Добрый день! Чем могу помочь?", timestampRaw: "00:05" },
      { messageIndex: 2, speaker: "client", text: "Подскажите баланс лицевого счета 12345.", timestampRaw: "00:15" },
      { messageIndex: 3, speaker: "operator", text: "Ваш баланс 500 рублей.", timestampRaw: "00:30" },
    ],
  };
}

function createMockEvaluation(
  id: string,
  conversationId: string,
  options: {
    configHash?: string;
    model?: string;
    promptVersion?: string;
    source?: "ai" | "heuristic" | "manual" | "demo";
    status?: "completed" | "needs_review" | "failed" | "not_scorable";
    critical?: boolean;
    costUsd?: number;
    calls?: number;
    baseResults?: CriterionResult[];
    finalResults?: CriterionResult[];
  } = {},
): Evaluation {
  const defaultResults: CriterionResult[] = [
    {
      criterionId: "C01",
      answer: "yes",
      reason: "Оператор поздоровался в первой реплике.",
      evidence: [{ messageIndex: 1, quote: "Добрый день! Чем могу помочь?", speaker: "operator" }],
      checkedRange: { from: 0, to: 1 },
      naReason: null,
      validationStatus: "ok",
      weight: 10,
      normalized: 10,
      contribution: 10,
      isNa: false,
      critical: false,
    },
    {
      criterionId: "C02",
      answer: "na",
      reason: "Клиент сформулировал вопрос сразу без невнятных формулировок.",
      evidence: [],
      checkedRange: null,
      naReason: "Запрос клиента понятен и сформулирован сразу",
      validationStatus: "ok",
      weight: 10,
      normalized: null,
      contribution: null,
      isNa: true,
      critical: false,
    },
    {
      criterionId: "C08",
      answer: options.critical ? "yes" : "no",
      reason: options.critical
        ? 'Грубость: оператор использовал фразу "Вы сами виноваты".'
        : "Грубости и оскорблений не зафиксировано.",
      evidence: options.critical
        ? [{ messageIndex: 3, quote: "Вы сами виноваты", speaker: "operator" }]
        : [],
      checkedRange: null,
      naReason: null,
      validationStatus: "ok",
      weight: 0,
      normalized: options.critical ? 0 : 1,
      contribution: 0,
      isNa: false,
      critical: options.critical ?? false,
    },
  ];

  const results = options.baseResults ?? defaultResults;

  return {
    id,
    conversationId,
    checklistVersionId: "official-chat-v1",
    configHash: options.configHash ?? "hash-abc-123",
    model: options.model ?? "grok-4.7",
    promptVersion: options.promptVersion ?? "cqa-s5-v5",
    startedAt: "2026-11-07T22:00:00.000Z",
    source: options.source ?? "ai",
    status: options.status ?? "completed",
    createdAt: "2026-11-07T22:00:05.000Z",
    baseResults: results,
    finalResults: options.finalResults ?? results,
    baseTotal: options.critical ? 0 : 85,
    finalTotal: options.critical ? 0 : 85,
    baseRaw: options.critical ? 0 : 85,
    finalRaw: options.critical ? 0 : 85,
    baseCritical: options.critical ?? false,
    finalCritical: options.critical ?? false,
    usage: {
      promptTokens: 1200,
      completionTokens: 350,
      estimatedCostUsd: options.costUsd ?? 0.0042,
      calls: options.calls ?? 1,
    },
    trace: ["init", "scored", "verified"],
  };
}

test("Stage I.3: csvCell escaping for quotes, commas, semicolons, and newlines", () => {
  // Empty, null, undefined
  assert.equal(csvCell(""), "");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");

  // Numbers and booleans
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(42.5), "42.5");
  assert.equal(csvCell(true), "true");
  assert.equal(csvCell(false), "false");

  // Plain strings
  assert.equal(csvCell("simple_text"), "simple_text");
  assert.equal(csvCell("RU"), "RU");

  // Commas require quotes
  assert.equal(csvCell("hello, world"), '"hello, world"');

  // Semicolons require quotes (essential for Excel & CQA criteria evidence)
  assert.equal(csvCell("item1; item2"), '"item1; item2"');

  // Double quotes require wrapping and doubling
  assert.equal(csvCell('He said "Hello"'), '"He said ""Hello"""');

  // Newlines require quotes
  assert.equal(csvCell("Line 1\nLine 2"), '"Line 1\nLine 2"');
  assert.equal(csvCell("Line 1\r\nLine 2"), '"Line 1\r\nLine 2"');

  // Combined quotes, semicolons, commas, and newlines
  const complex = 'Привет; "мир",\nновая строка';
  assert.equal(csvCell(complex), '"Привет; ""мир"",\nновая строка"');
});

test("Stage I.3: formatEvidenceQuotes and formatCheckedRange formatting", () => {
  // Evidence formatting
  assert.equal(formatEvidenceQuotes([]), "");
  assert.equal(formatEvidenceQuotes(null), "");
  assert.equal(formatEvidenceQuotes(undefined), "");

  const singleEvidence = [{ messageIndex: 1, quote: "Добрый день!", speaker: "operator" }];
  assert.equal(formatEvidenceQuotes(singleEvidence), "[#1 operator] Добрый день!");

  const withoutSpeaker = [{ messageIndex: 2, quote: "Клиент ожидает" }];
  assert.equal(formatEvidenceQuotes(withoutSpeaker), "[#2] Клиент ожидает");

  const multiEvidence = [
    { messageIndex: 0, quote: "Привет", speaker: "client" },
    { messageIndex: 1, quote: "Здравствуйте", speaker: "operator" },
  ];
  assert.equal(
    formatEvidenceQuotes(multiEvidence),
    "[#0 client] Привет; [#1 operator] Здравствуйте",
  );

  // CheckedRange formatting
  assert.equal(formatCheckedRange(null), "");
  assert.equal(formatCheckedRange(undefined), "");
  assert.equal(formatCheckedRange({ from: 0, to: 1 }), "0-1");
  assert.equal(formatCheckedRange({ from: 2, to: 5 }), "2-5");
});

test("Stage I.3: resultsToCsv starts with UTF-8 BOM (\uFEFF) for Excel Cyrillic compatibility", () => {
  const conv = createMockConversation("c-1", "DEV", "ext-1");
  const evalItem = createMockEvaluation("e-1", "c-1");
  const rows = resultRows([conv], [evalItem]);
  const csv = resultsToCsv(rows);

  // Must begin with BOM character
  assert.ok(csv.startsWith(UTF8_BOM), "CSV must start with UTF-8 BOM");
  assert.equal(csv.charCodeAt(0), 0xfeff, "First char code must be 0xFEFF");

  // In binary representation, first 3 bytes must be EF BB BF
  const buffer = Buffer.from(csv, "utf-8");
  assert.equal(buffer[0], 0xef);
  assert.equal(buffer[1], 0xbb);
  assert.equal(buffer[2], 0xbf);
});

test("Stage I.3: CSV columns order: first 17 core columns and answers preserved, new columns appended at end", () => {
  const conv = createMockConversation("conv-1", "GROUP_A", "ext-001", "RU", "voice");
  const evalItem = createMockEvaluation("eval-1", "conv-1", {
    configHash: "cfg-hash-xyz",
    model: "grok-4.7",
    promptVersion: "cqa-s5-v5",
    source: "ai",
    status: "completed",
    critical: false,
    costUsd: 0.005,
    calls: 2,
  });

  const rows = resultRows([conv], [evalItem]);
  const csv = resultsToCsv(rows);

  // Strip BOM for header parsing
  const cleanCsv = csv.replace(/^\uFEFF/, "");
  const lines = cleanCsv.split("\n");
  const header = lines[0].split(",");

  // Check first 17 columns match original layout
  const expectedFirst17 = [
    "conversationId",
    "externalId",
    "language",
    "channel",
    "groupId",
    "source",
    "model",
    "promptVersion",
    "checklistVersionId",
    "status",
    "baseTotal",
    "finalTotal",
    "critical",
    "promptTokens",
    "completionTokens",
    "estimatedCostUsd",
    "calls",
  ];

  for (let i = 0; i < expectedFirst17.length; i++) {
    assert.equal(
      header[i],
      expectedFirst17[i],
      `Column index ${i} must be ${expectedFirst17[i]}, got ${header[i]}`,
    );
  }

  // Next are criterion answer columns in sorted order (C01, C02, C08)
  assert.equal(header[17], "C01");
  assert.equal(header[18], "C02");
  assert.equal(header[19], "C08");

  // Directly following answer columns is configHash
  assert.equal(header[20], "configHash");

  // Following configHash are detail columns for each criterion: reason, evidence, checked_range, na_reason
  const expectedDetailColumns = [
    "C01_reason",
    "C01_evidence",
    "C01_checked_range",
    "C01_na_reason",
    "C02_reason",
    "C02_evidence",
    "C02_checked_range",
    "C02_na_reason",
    "C08_reason",
    "C08_evidence",
    "C08_checked_range",
    "C08_na_reason",
  ];

  for (let i = 0; i < expectedDetailColumns.length; i++) {
    assert.equal(
      header[21 + i],
      expectedDetailColumns[i],
      `Detail column at ${21 + i} must be ${expectedDetailColumns[i]}`,
    );
  }
});

test("Stage I.3: CSV data row correctly populates all new fields with proper quoting", () => {
  const conv = createMockConversation("c-test", "DEV-STAGE", "ext-99", "KZ", "web-chat");
  const evalItem = createMockEvaluation("e-test", "c-test", {
    configHash: "sha256-abc12345",
    model: "grok-4.7",
    promptVersion: "cqa-s5-v5",
    critical: true,
    costUsd: 0.0123,
    calls: 3,
  });

  const rows = resultRows([conv], [evalItem]);
  const csv = resultsToCsv(rows);

  // Strip BOM
  const cleanCsv = csv.replace(/^\uFEFF/, "");
  const lines = cleanCsv.split("\n");
  assert.equal(lines.length, 2, "Should contain header and one data row");

  const dataLine = lines[1];

  // Check expected substrings in data row
  assert.ok(dataLine.includes("c-test"), "Must contain conversationId");
  assert.ok(dataLine.includes("ext-99"), "Must contain externalId");
  assert.ok(dataLine.includes("KZ"), "Must contain language");
  assert.ok(dataLine.includes("web-chat"), "Must contain channel");
  assert.ok(dataLine.includes("DEV-STAGE"), "Must contain groupId");
  assert.ok(dataLine.includes("sha256-abc12345"), "Must contain configHash");
  assert.ok(dataLine.includes("0.0123"), "Must contain cost");
  assert.ok(dataLine.includes("3"), "Must contain calls");

  // Evidence containing semicolon must be escaped in double quotes
  // e.g. "[#1 operator] Добрый день! Чем могу помочь?"
  assert.ok(
    dataLine.includes('"[#1 operator] Добрый день! Чем могу помочь?"') ||
    dataLine.includes('[#1 operator] Добрый день! Чем могу помочь?'),
    "Evidence must be present",
  );

  // Checked range
  assert.ok(dataLine.includes("0-1"), "Checked range 0-1 must be present");

  // N/A reason
  assert.ok(
    dataLine.includes("Запрос клиента понятен и сформулирован сразу"),
    "N/A reason must be present",
  );

  // Critical violation reason containing quote must have escaped quotes
  assert.ok(
    dataLine.includes('""Вы сами виноваты""'),
    "Quotes inside reason must be escaped as double-quotes",
  );
});

test("Stage I.3: JSON export via resultRows contains all required organizer fields and aliases", () => {
  const conv = createMockConversation("c-json-1", "DEV_DATASET", "ext-json-1", "EN", "email");
  const evalItem = createMockEvaluation("e-json-1", "c-json-1", {
    configHash: "hash-json-v1",
    model: "grok-4.7",
    promptVersion: "cqa-s5-v5",
    source: "ai",
    status: "completed",
    critical: false,
    costUsd: 0.0075,
    calls: 2,
  });

  const rows = resultRows([conv], [evalItem]);
  assert.equal(rows.length, 1);
  const row = rows[0];

  // Core metadata
  assert.equal(row.conversationId, "c-json-1");
  assert.equal(row.groupId, "DEV_DATASET");
  assert.equal(row.channel, "email");
  assert.equal(row.language, "EN");
  assert.equal(row.checklistVersionId, "official-chat-v1");
  assert.equal(row.configHash, "hash-json-v1");
  assert.equal(row.model, "grok-4.7");
  assert.equal(row.promptVersion, "cqa-s5-v5");
  assert.equal(row.source, "ai");
  assert.equal(row.status, "completed");
  assert.equal(row.baseTotal, 85);
  assert.equal(row.finalTotal, 85);
  assert.equal(row.critical, false);
  assert.equal(row.estimatedCostUsd, 0.0075);
  assert.equal(row.calls, 2);

  // Per-criterion detailed breakdown
  assert.ok(row.criteria, "Must contain criteria map");

  const c01 = row.criteria.C01;
  assert.equal(c01.answer, "yes");
  assert.equal(c01.reason, "Оператор поздоровался в первой реплике.");
  assert.equal(c01.evidence.length, 1);
  assert.equal(c01.evidence[0].messageIndex, 1);
  assert.equal(c01.evidence[0].quote, "Добрый день! Чем могу помочь?");
  assert.deepEqual(c01.checkedRange, { from: 0, to: 1 });
  assert.equal(c01.naReason, null);

  const c02 = row.criteria.C02;
  assert.equal(c02.answer, "na");
  assert.equal(c02.naReason, "Запрос клиента понятен и сформулирован сразу");
  assert.equal(c02.checkedRange, null);

  // JSON serialization test (JSON.stringify works cleanly without circular structures)
  const jsonString = JSON.stringify(rows, null, 2);
  const parsed = JSON.parse(jsonString);
  assert.equal(parsed[0].conversationId, "c-json-1");
  assert.equal(parsed[0].groupId, "DEV_DATASET");
  assert.equal(parsed[0].criteria.C01.answer, "yes");
});

test("Stage I.3: Appeal override updates answers and criteria while retaining baseTotal vs finalTotal", () => {
  const conv = createMockConversation("c-appeal", "DEV", "ext-app");

  const baseResults: CriterionResult[] = [
    {
      criterionId: "C01",
      answer: "no",
      reason: "Модель ошибочно не нашла приветствие.",
      evidence: [],
      checkedRange: { from: 0, to: 1 },
      naReason: null,
      validationStatus: "invalid_evidence",
      weight: 10,
      normalized: 0,
      contribution: 0,
      isNa: false,
      critical: false,
    },
  ];

  const overriddenResults: CriterionResult[] = [
    {
      criterionId: "C01",
      answer: "yes",
      reason: "Апелляция удовлетворена: приветствие присутствует в реплике #1.",
      evidence: [{ messageIndex: 1, quote: "Добрый день! Чем могу помочь?", speaker: "operator" }],
      checkedRange: { from: 0, to: 1 },
      naReason: null,
      validationStatus: "ok",
      weight: 10,
      normalized: 10,
      contribution: 10,
      isNa: false,
      critical: false,
    },
  ];

  const evalItem = createMockEvaluation("e-appeal", "c-appeal", {
    baseResults,
    finalResults: overriddenResults,
  });
  evalItem.baseTotal = 70;
  evalItem.finalTotal = 80;

  const rows = resultRows([conv], [evalItem]);
  assert.equal(rows[0].baseTotal, 70);
  assert.equal(rows[0].finalTotal, 80);
  assert.equal(rows[0].answers.C01, "yes");
  assert.equal(rows[0].criteria.C01.answer, "yes");
  assert.equal(
    rows[0].criteria.C01.reason,
    "Апелляция удовлетворена: приветствие присутствует в реплике #1.",
  );

  const csv = resultsToCsv(rows);
  assert.ok(csv.includes("70"), "Base total 70 in CSV");
  assert.ok(csv.includes("80"), "Final total 80 in CSV");
  assert.ok(
    csv.includes("Апелляция удовлетворена: приветствие присутствует в реплике #1."),
    "Updated reason in CSV",
  );
});

test("Stage J: resultRows latestOnly exports 1 newest row per conversation; latestOnly false exports all", () => {
  const conv = createMockConversation("c-multi-run", "DEV", "ext-multi");

  const evalOld = createMockEvaluation("e-old", "c-multi-run", {
    model: "old-model-run",
    status: "completed",
  });
  evalOld.createdAt = "2026-11-08T01:00:00Z";
  evalOld.baseTotal = 50;
  evalOld.finalTotal = 50;

  const evalNew = createMockEvaluation("e-new", "c-multi-run", {
    model: "new-model-run",
    status: "completed",
  });
  evalNew.createdAt = "2026-11-08T02:00:00Z";
  evalNew.baseTotal = 95;
  evalNew.finalTotal = 95;

  // 1. By default (latestOnly: true) -> exactly 1 row with new model
  const defaultRows = resultRows([conv], [evalOld, evalNew]);
  assert.equal(defaultRows.length, 1);
  assert.equal(defaultRows[0].model, "new-model-run");
  assert.equal(defaultRows[0].finalTotal, 95);

  const defaultCsv = resultsToCsv(defaultRows);
  const defaultCsvLines = defaultCsv.trim().split("\n");
  // Header line + 1 data line = 2 lines
  assert.equal(defaultCsvLines.length, 2);
  assert.ok(defaultCsv.includes("new-model-run"));
  assert.ok(!defaultCsv.includes("old-model-run"));

  // 2. With latestOnly: false -> 2 rows (both evaluations)
  const allRows = resultRows([conv], [evalOld, evalNew], { latestOnly: false });
  assert.equal(allRows.length, 2);

  const allCsv = resultsToCsv(allRows);
  const allCsvLines = allCsv.trim().split("\n");
  // Header line + 2 data lines = 3 lines
  assert.equal(allCsvLines.length, 3);
  assert.ok(allCsv.includes("new-model-run"));
  assert.ok(allCsv.includes("old-model-run"));
});
