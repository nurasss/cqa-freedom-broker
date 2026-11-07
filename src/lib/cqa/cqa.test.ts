import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkByRun, evaluateBenchmark, resultsToCsv, resultRows } from "./benchmark.ts";
import { controlCases } from "./control.ts";
import { assemble, draftsFromModelPayload, parseImport, parseMediaOffset } from "./engine.ts";
import type { DraftAnswer } from "./engine.ts";
import { applySemanticVerdicts } from "./semantic-judge.ts";
import { createBatchRunner, runQueue } from "./queue.ts";
import { rulesDrafts } from "./rules.ts";
import { computeScore, validateChecklist } from "./score.ts";
import { officialCriteria, officialVersion } from "./seed.ts";
import { selectBatchTargets, useCqa } from "./store.ts";
import type { Answer, Criterion, TranscriptMessage } from "./types.ts";

function messages(): TranscriptMessage[] {
  return [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте" },
    { messageIndex: 1, timestampRaw: "00:08", speaker: "operator", text: "Какой у вас вопрос по счёту?" },
  ];
}

function draft(criterion: Criterion, answer: Answer, quotes: DraftAnswer["quotes"] = [], range: DraftAnswer["checkedRange"] = { from: 0, to: 1 }): DraftAnswer {
  return {
    criterionId: criterion.id,
    answer,
    reason: "Проверка валидации доказательства на коротком диалоге.",
    quotes,
    checkedRange: answer === "na" ? null : range,
    naReason: answer === "na" ? "Критерий неприменим к этому фрагменту" : null,
  };
}

function baseline(over: Partial<Record<string, DraftAnswer>> = {}): DraftAnswer[] {
  return officialCriteria.map((criterion) => {
    if (over[criterion.id]) return over[criterion.id]!;
    if (criterion.id === "C07") return draft(criterion, "no");
    if (criterion.answerType === "scale") return draft(criterion, 0);
    if (criterion.answerType === "yes_no_na") return draft(criterion, "na");
    return draft(criterion, "no");
  });
}

test("client greeting cannot prove operator contact", () => {
  const c01 = officialCriteria[0]!;
  const assembled = assemble(officialCriteria, messages(), baseline({
    C01: draft(c01, "yes", [{ messageIndex: 0, quote: "Здравствуйте" }], null),
  }));
  const result = assembled.results.find((item) => item.criterionId === "C01");
  assert.notEqual(assembled.status, "completed");
  assert.equal(result?.validationStatus, "invalid_evidence");
  assert.match(assembled.errors.join(" "), /не подтверждает действие оператора/);
});

test("operator greeting in the first reply can complete", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Нужна комиссия." },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим, Freedom Broker." },
  ];
  const c01 = officialCriteria[0]!;
  const assembled = assemble(officialCriteria, lines, baseline({
    C01: draft(c01, "yes", [{ messageIndex: 1, quote: "Здравствуйте! Меня зовут Айгерим" }], null),
  }));
  assert.equal(assembled.results.find((item) => item.criterionId === "C01")?.validationStatus, "ok");
  assert.equal(assembled.status, "completed");
});

test("missed action keeps an expected range", () => {
  const assembled = assemble(officialCriteria, messages(), baseline());
  const result = assembled.results.find((item) => item.criterionId === "C01");
  assert.equal(result?.answer, "no");
  assert.deepEqual(result?.checkedRange, { from: 0, to: 1 });
  assert.equal(result?.validationStatus, "ok");
});

test("quote index must match the source line", () => {
  const c01 = officialCriteria[0]!;
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Добрый день" },
    { messageIndex: 1, timestampRaw: "00:04", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим." },
  ];
  const assembled = assemble(officialCriteria, lines, baseline({
    C01: draft(c01, "yes", [{ messageIndex: 0, quote: "Здравствуйте! Меня зовут Айгерим" }], null),
  }));
  assert.notEqual(assembled.status, "completed");
});

test("critical flag needs an operator violation and does not zero the score", () => {
  const answers = {
    C01: "yes",
    C02: "yes",
    C03: "no",
    C04: 15,
    C05: "yes",
    C06: 7,
    C07: "no",
    C08: "yes",
  } as Record<string, Answer>;
  const scored = computeScore(officialCriteria, answers);
  assert.equal(scored.total, 65.5);
  assert.equal(scored.critical, true);
  const c08 = officialCriteria.find((item) => item.id === "C08")!;
  const falseFlag = assemble(officialCriteria, messages(), baseline({
    C08: draft(c08, "yes", [{ messageIndex: 0, quote: "Здравствуйте" }], null),
  }));
  assert.equal(falseFlag.outcome.critical, false);
  assert.notEqual(falseFlag.status, "completed");
});

test("forbidden N/A and scale steps", () => {
  for (const id of ["C01", "C05", "C06", "C08"]) {
    const answers = {
      C01: "yes",
      C02: "yes",
      C03: "no",
      C04: 15,
      C05: "yes",
      C06: 7,
      C07: "no",
      C08: "no",
      [id]: "na",
    } as Record<string, Answer>;
    assert.equal(computeScore(officialCriteria, answers).status, "invalid");
  }
  assert.equal(validateChecklist(officialVersion().criteria).length, 0);
});

test("timestamps and duplicate import records", () => {
  const records = Array.from({ length: 65 }, (_, index) => ({
    conversation_id: `dev-${index}`,
    channel: index % 2 ? "voice call" : "agent chat",
    language: index % 3 === 0 ? "RU" : index % 3 === 1 ? "KZ" : "EN",
    transcript: [{ timestamp: "2026-11-06T10:15:02+05:00", speaker: "Agent", text: "Здравствуйте" }],
  }));
  records.push({ ...records[0]!, conversation_id: "dev-0" });
  records.push({ conversation_id: "", channel: "agent chat", language: "RU", transcript: [] });
  const parsed = parseImport(
    { isSuccess: true, error: "", data: { dataset_group_id: "DEV", total_records: 65, records } },
    "DEV",
    "organizer",
  );
  assert.equal(parsed.conversations.length, 65);
  assert.equal(parsed.conversations[0]?.messages[0]?.timestampRaw, "2026-11-06T10:15:02+05:00");
  assert.equal(parsed.conversations[0]?.messages[0]?.speaker, "operator");
  assert.equal(parsed.conversations[0]?.origin, "organizer");
  assert.match(parsed.error ?? "", /дубль/);
  assert.equal(parsed.channels.chat + parsed.channels.call, 65);
  const rejected = parseImport({ isSuccess: false, error: "closed", data: { records } }, "DEV");
  assert.equal(rejected.conversations.length, 0);
  useCqa.getState().resetLocal();
  const first = useCqa.getState().importConversations(parsed.conversations, "API DEV");
  const second = useCqa.getState().importConversations(parsed.conversations, "API DEV");
  assert.equal(first.added, 65);
  assert.equal(second.added, 0);
});

test("batch of 65 and failed-only retry", async () => {
  let calls = 0;
  const outcome = await runQueue({
    items: Array.from({ length: 65 }, (_, index) => ({ id: `id-${index}`, payload: index })),
    concurrency: 4,
    maxAttempts: 1,
    retryDelayMs: 0,
    work: async () => {
      calls += 1;
      return "completed";
    },
  });
  assert.equal(outcome.completed, 65);
  assert.equal(calls, 65);
  let attempts = 0;
  const retried = await runQueue({
    items: [{ id: "one", payload: 1 }],
    concurrency: 1,
    maxAttempts: 3,
    retryDelayMs: 0,
    work: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("429");
      return "needs_review";
    },
  });
  assert.equal(retried.needsReview, 1);
  assert.equal(attempts, 2);
  const runner = createBatchRunner();
  const held = runner.run({
    items: [{ id: "a", payload: 1 }],
    concurrency: 1,
    maxAttempts: 1,
    retryDelayMs: 0,
    work: () => new Promise((resolve) => setTimeout(() => resolve("completed"), 40)),
  });
  await assert.rejects(() => runner.run({
    items: [{ id: "b", payload: 2 }],
    concurrency: 1,
    maxAttempts: 1,
    retryDelayMs: 0,
    work: async () => "completed",
  }), /уже выполняется/);
  await held;
});

function keepAnswer(assembled: ReturnType<typeof assemble>, ids: string[], explanation: string) {
  const judged = applySemanticVerdicts(
    assembled,
    assembled.results.map((result) => ({
      criterionId: result.criterionId,
      status: ids.includes(result.criterionId) ? "invalid" : "valid",
      explanation: ids.includes(result.criterionId) ? explanation : "Ответ согласован с рубрикой этой версии.",
    })),
  );
  for (const id of ids) {
    assert.equal(judged.results.find((item) => item.criterionId === id)?.answer, assembled.results.find((item) => item.criterionId === id)?.answer);
    assert.equal(judged.results.find((item) => item.criterionId === id)?.validationStatus, "invalid_evidence");
  }
  assert.equal(judged.status, "needs_review");
  assert.match(judged.errors.join(" "), new RegExp(explanation.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return judged;
}

test("greeting without introduction is not reliable C01", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Нужна комиссия по тарифу." },
    { messageIndex: 1, timestampRaw: "00:04", speaker: "operator", text: "Здравствуйте! Комиссия 0,3%." },
  ];
  const c01 = officialCriteria.find((item) => item.id === "C01")!;
  const assembled = assemble(officialCriteria, lines, baseline({
    C01: draft(c01, "yes", [{ messageIndex: 1, quote: "Здравствуйте" }], null),
  }));
  assert.equal(assembled.results.find((item) => item.criterionId === "C01")?.validationStatus, "ok");
  const judged = keepAnswer(assembled, ["C01"], "приветствие без представления не подтверждает рубрику");
  assert.equal(judged.results.find((item) => item.criterionId === "C01")?.answer, "yes");
});

test("identity request is not confirmation and disclosure blocks C03 N/A", () => {
  const ask: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Какая комиссия тарифа Стандарт?" },
    { messageIndex: 1, timestampRaw: "00:06", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Назовите последние 4 цифры ИИН." },
  ];
  const c03 = officialCriteria.find((item) => item.id === "C03")!;
  const asked = assemble(officialCriteria, ask, baseline({
    C03: draft(c03, "yes", [{ messageIndex: 1, quote: "Назовите последние 4 цифры ИИН" }], null),
  }));
  assert.equal(asked.results.find((item) => item.criterionId === "C03")?.answer, "yes");
  keepAnswer(asked, ["C03"], "запрос ИИН не является подтверждением личности");

  const leaked: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Скажите остаток." },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "На вашем счёте 12000 тенге." },
  ];
  const na = assemble(officialCriteria, leaked, baseline({
    C03: draft(c03, "na", [], null),
  }));
  assert.equal(na.results.find((item) => item.criterionId === "C03")?.answer, "na");
  const blocked = keepAnswer(na, ["C03"], "N/A недопустим: защищённые сведения уже раскрыты");
  assert.equal(blocked.results.find((item) => item.criterionId === "C03")?.validationStatus, "invalid_evidence");
});

test("farewell without a summary and ordinary mistake are not reliable", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Нужна комиссия тарифа Стандарт за акции США." },
    { messageIndex: 1, timestampRaw: "00:08", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Комиссия ноль, всегда бесплатно. Хорошего дня!" },
  ];
  const c07 = officialCriteria.find((item) => item.id === "C07")!;
  const c08 = officialCriteria.find((item) => item.id === "C08")!;
  const assembled = assemble(officialCriteria, lines, baseline({
    C07: draft(c07, "yes", [{ messageIndex: 1, quote: "Хорошего дня" }], null),
    C08: draft(c08, "yes", [{ messageIndex: 1, quote: "Комиссия ноль, всегда бесплатно" }], null),
  }));
  const judged = keepAnswer(assembled, ["C07", "C08"], "прощание без итога и обычная ошибка не подтверждают ответы");
  assert.equal(judged.results.find((item) => item.criterionId === "C07")?.answer, "yes");
  assert.equal(judged.results.find((item) => item.criterionId === "C08")?.answer, "yes");
  assert.equal(judged.outcome.critical, false);
});

test("identity request, denied check and bare balance are not a reliable C03", () => {
  const c03 = officialCriteria.find((item) => item.id === "C03")!;
  const asked: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Нужна комиссия и статус вывода." },
    { messageIndex: 1, timestampRaw: "00:06", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Подтвердите личность и назовите ИИН." },
    { messageIndex: 2, timestampRaw: "00:12", speaker: "operator", text: "Баланс: 15000 тенге." },
  ];
  const premature = assemble(officialCriteria, asked, baseline({
    C03: draft(c03, "yes", [{ messageIndex: 1, quote: "Подтвердите личность" }], { from: 0, to: 2 }),
  }));
  assert.equal(premature.results.find((item) => item.criterionId === "C03")?.answer, "yes");
  keepAnswer(premature, ["C03"], "просьба подтвердить личность ещё не подтверждение");

  const denied: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Скажите остаток по заявке." },
    { messageIndex: 1, timestampRaw: "00:08", speaker: "operator", text: "Личность не подтверждена. Баланс: 15000 тенге." },
  ];
  const blocked = assemble(officialCriteria, denied, baseline({
    C03: draft(c03, "na", [], null),
  }));
  assert.equal(blocked.results.find((item) => item.criterionId === "C03")?.answer, "na");
  keepAnswer(blocked, ["C03"], "раскрытие баланса без идентификации не может быть N/A");

  const proper: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Какой статус вывода по заявке?" },
    { messageIndex: 1, timestampRaw: "00:20", speaker: "operator", text: "Личность подтверждена. На вашем счёте 430000 тенге." },
  ];
  const accepted = assemble(officialCriteria, proper, baseline({
    C03: draft(c03, "yes", [{ messageIndex: 1, quote: "Личность подтверждена" }], null),
  }));
  assert.equal(accepted.results.find((item) => item.criterionId === "C03")?.validationStatus, "ok");
});

test("vague need, formulated disconnect and ordinary transfer are not reliable N/A or C08", () => {
  const c02 = officialCriteria.find((item) => item.id === "C02")!;
  const vague: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте, я хотел бы кое-что спросить, если вам не сложно и есть минута." },
    { messageIndex: 1, timestampRaw: "00:08", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим." },
  ];
  const need = assemble(officialCriteria, vague, baseline({
    C02: draft(c02, "na", [], null),
  }));
  keepAnswer(need, ["C02"], "N/A нельзя: данных для ответа с начала не хватало");

  const c04 = officialCriteria.find((item) => item.id === "C04")!;
  const dropped: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Подскажите комиссию тарифа Стандарт." },
    { messageIndex: 1, timestampRaw: "00:04", speaker: "system", text: "Клиент покинул чат." },
  ];
  const consult = assemble(officialCriteria, dropped, baseline({
    C04: draft(c04, "na", [], null),
  }));
  keepAnswer(consult, ["C04"], "N/A нельзя: запрос уже сформулирован до обрыва");

  const c08 = officialCriteria.find((item) => item.id === "C08")!;
  const kaspi: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Какая комиссия при переводе через Kaspi?" },
    { messageIndex: 1, timestampRaw: "00:06", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Переведите на брокерский счёт через Kaspi, комиссия 0,3%." },
  ];
  const flag = assemble(officialCriteria, kaspi, baseline({
    C08: draft(c08, "yes", [{ messageIndex: 1, quote: "Переведите на брокерский счёт через Kaspi" }], null),
  }));
  const ordinary = keepAnswer(flag, ["C08"], "перевод через Kaspi не является грубым нарушением");
  assert.equal(ordinary.results.find((item) => item.criterionId === "C08")?.answer, "yes");
  assert.equal(ordinary.outcome.critical, false);

  const insult: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Нужна комиссия." },
    { messageIndex: 1, timestampRaw: "00:06", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Не пишите ерунду." },
  ];
  const gross = assemble(officialCriteria, insult, baseline({
    C08: draft(c08, "yes", [{ messageIndex: 1, quote: "Не пишите ерунду" }], null),
  }));
  assert.equal(gross.results.find((item) => item.criterionId === "C08")?.validationStatus, "ok");
  assert.equal(gross.outcome.critical, true);
});

test("greeting in another language is not reliable contact", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "What is the tariff fee?" },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим." },
  ];
  const c01 = officialCriteria.find((item) => item.id === "C01")!;
  const assembled = assemble(officialCriteria, lines, baseline({
    C01: draft(c01, "yes", [{ messageIndex: 1, quote: "Здравствуйте" }], null),
  }));
  const judged = keepAnswer(assembled, ["C01"], "приветствие не на языке клиента не подтверждает рубрику");
  assert.equal(judged.results.find((item) => item.criterionId === "C01")?.answer, "yes");
});

test("batch evaluation keeps the checklist captured at start", () => {
  useCqa.getState().resetLocal();
  const started = useCqa.getState().versions.find((item) => item.id === useCqa.getState().activeVersionId)!;
  const conversationId = useCqa.getState().conversations[0]!.id;
  const criteria = started.criteria.map((criterion) =>
    criterion.id === "C05" ? { ...criterion, title: `${criterion.title} другая` } : criterion,
  );
  assert.deepEqual(useCqa.getState().saveVersion(criteria), []);
  assert.notEqual(useCqa.getState().activeVersionId, started.id);
  const evaluationId = useCqa.getState().evaluateRules(conversationId, started.id);
  const saved = useCqa.getState().evaluations.find((item) => item.id === evaluationId);
  assert.equal(saved?.checklistVersionId, started.id);
  assert.equal(saved?.configHash, started.configHash);
  assert.notEqual(saved?.checklistVersionId, useCqa.getState().activeVersionId);
});

test("local study set is ten RU KZ EN transcripts and not the official control group", () => {
  const cases = controlCases();
  assert.equal(cases.length, 34);
  const languages = new Set(cases.map((item) => item.conversation.language));
  assert.deepEqual([...languages].sort(), ["EN", "KZ", "RU"]);
  for (const item of cases) {
    assert.equal(item.conversation.origin, "study");
    assert.equal(item.conversation.datasetGroupId, "STUDY");
    assert.ok(!item.conversation.id.startsWith("CONTROL::"));
    for (const criterion of officialCriteria) assert.ok(criterion.id in item.answers);
    const drafts = rulesDrafts(officialCriteria, item.conversation);
    const assembled = assemble(officialCriteria, item.conversation.messages, drafts);
    assert.ok(assembled.status === "completed" || assembled.status === "needs_review" || assembled.status === "not_scorable");
  }
});

test("benchmark metrics are local and not organizer ground truth", () => {
  const cases = controlCases();
  const perfect = cases.map((item) => ({
    id: item.conversation.id,
    language: item.conversation.language,
    model: "gold",
    promptVersion: "manual",
    gold: item.answers,
    predicted: item.answers,
  }));
  const exact = evaluateBenchmark(officialCriteria, perfect);
  assert.equal(exact.mae, 0);
  assert.equal(exact.needsReview, 0);
  assert.equal(exact.critical.f1, 1);
  assert.match(exact.disclaimer, /не является скрытым Ground Truth/);
  const heuristic = cases.map((item) => ({
    id: item.conversation.id,
    language: item.conversation.language,
    model: "rules-heuristic-v1",
    promptVersion: "rules-v1",
    gold: item.answers,
    predicted: Object.fromEntries(rulesDrafts(officialCriteria, item.conversation).map((row) => [row.criterionId, row.answer])) as Record<string, Answer>,
  }));
  const report = evaluateBenchmark(officialCriteria, heuristic);
  assert.equal(report.compared, 34);
  assert.ok(report.mae === null || Number.isFinite(report.mae));
  assert.ok(report.byLanguage.RU);
  assert.ok(report.scaleConfusion.C04);
  const runs = benchmarkByRun(officialCriteria, [
    ...heuristic,
    ...heuristic.map((item) => ({ ...item, model: "grok-4.5", promptVersion: "cqa-s5-v2" })),
  ]);
  assert.equal(Object.keys(runs).length, 2);
  const flagged = evaluateBenchmark(officialCriteria, [{ ...perfect[0]!, needsReview: true }]);
  assert.equal(flagged.needsReview, 1);
});

test("AI batch does not treat a heuristic result as already scored", () => {
  const base = {
    checklistVersionId: "official-chat-v1",
    configHash: "hash-a",
    model: "grok-4.5",
    promptVersion: "cqa-s5-v4.1",
    createdAt: "2026-11-07T10:00:00.000Z",
  };
  const query = {
    conversationIds: ["a", "b", "c"],
    versionId: "official-chat-v1",
    configHash: "hash-a",
    mode: "ai" as const,
    modelId: "grok-4.5",
    promptVersion: "cqa-s5-v4.1",
    onlyFailed: false,
    failedJobIds: ["c"],
    evaluations: [
      { ...base, conversationId: "a", source: "heuristic" as const, model: "rules-heuristic-v1", promptVersion: "rules-v1", status: "completed" as const },
      { ...base, conversationId: "b", source: "ai" as const, status: "completed" as const },
    ],
  };
  assert.deepEqual(selectBatchTargets(query), ["a", "c"]);
  assert.deepEqual(
    selectBatchTargets({
      ...query,
      evaluations: [
        ...query.evaluations,
        { ...base, conversationId: "a", source: "ai", status: "failed", createdAt: "2026-11-07T11:00:00.000Z" },
      ],
    }),
    ["a", "c"],
  );
  assert.deepEqual(selectBatchTargets({ ...query, onlyFailed: true }), ["c"]);
  assert.deepEqual(selectBatchTargets({ ...query, modelId: "grok-4", evaluations: [{ ...base, conversationId: "b", source: "ai", status: "completed" }] }).sort(), ["a", "b", "c"]);
  assert.deepEqual(
    selectBatchTargets({
      ...query,
      promptVersion: "cqa-s5-v4",
      evaluations: [{ ...base, conversationId: "b", source: "ai", status: "completed" }],
    }).sort(),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    selectBatchTargets({
      ...query,
      configHash: "hash-b",
      failedJobIds: [],
      evaluations: [{ ...base, conversationId: "b", source: "ai", status: "completed" }],
    }).sort(),
    ["a", "b", "c"],
  );
  const csv = resultsToCsv(
    resultRows(
      [
        {
          id: "a",
          datasetGroupId: "DEV",
          externalId: "dev-1",
          channel: "agent chat",
          language: "RU",
          audioUrl: null,
          origin: "organizer",
          messages: [],
        },
      ],
      [
        {
          id: "ev",
          conversationId: "a",
          checklistVersionId: "official-chat-v1",
          configHash: "hash-a",
          model: "grok-4.5",
          promptVersion: "cqa-s5-v4.1",
          startedAt: base.createdAt,
          source: "ai",
          status: "needs_review",
          createdAt: base.createdAt,
          baseResults: [],
          finalResults: [],
          baseTotal: 10,
          finalTotal: 10,
          baseRaw: 10,
          finalRaw: 10,
          baseCritical: false,
          finalCritical: false,
          usage: { promptTokens: 3, completionTokens: 2, estimatedCostUsd: 0.01, calls: 2 },
          trace: ["evaluation: completed", "judge C01: invalid"],
        },
      ],
    ),
  );
  assert.match(csv, /dev-1/);
  assert.match(csv, /needs_review/);
  assert.match(csv, /0\.01/);
});

test("model payload must cover the checklist", () => {
  const payload = {
    criteria: officialCriteria.map((criterion) => ({
      criterion_id: criterion.id,
      answer: criterion.id === "C04" ? 13 : criterion.answerType === "scale" ? 0 : "no",
      reason: "слишком коротко",
    })),
  };
  const drafted = draftsFromModelPayload(officialCriteria, payload);
  assert.ok(drafted.errors.some((error) => error.includes("C04")));
  const missing = draftsFromModelPayload(officialCriteria, { criteria: [] });
  assert.ok(missing.errors.some((error) => error.startsWith("Нет ")));
});

test("checklist edited during a call stays bound to the started version", () => {
  useCqa.getState().resetLocal();
  const started = useCqa.getState().versions.find((item) => item.id === useCqa.getState().activeVersionId)!;
  const conversationId = useCqa.getState().conversations[0]!.id;
  const criteria = started.criteria.map((criterion) => criterion.id === "C01" ? { ...criterion, title: `${criterion.title} правка` } : criterion);
  assert.deepEqual(useCqa.getState().saveVersion(criteria), []);
  assert.notEqual(useCqa.getState().activeVersionId, started.id);
  const savedId = useCqa.getState().saveModelEvaluation(
    {
      conversationId,
      checklistVersionId: started.id,
      configHash: started.configHash,
      modelId: "grok-4.5",
      promptVersion: "cqa-s5-v2",
      startedAt: "2026-11-07T09:00:00.000Z",
    },
    {
      status: "needs_review",
      results: [],
      total: null,
      raw: null,
      critical: false,
      model: "grok-4.5",
      promptVersion: "cqa-s5-v2",
      usage: { promptTokens: 10, completionTokens: 5, estimatedCostUsd: 0, calls: 1 },
      trace: ["спорные цитаты"],
      error: "needs review",
    },
  );
  const saved = useCqa.getState().evaluations.find((item) => item.id === savedId);
  assert.equal(saved?.checklistVersionId, started.id);
  assert.equal(saved?.configHash, started.configHash);
  assert.equal(saved?.startedAt, "2026-11-07T09:00:00.000Z");
  assert.equal(saved?.source, "ai");
  assert.notEqual(saved?.status, "completed");
});

test("appeal keeps base score and appends a decision", () => {
  useCqa.getState().resetLocal();
  const conversation = useCqa.getState().conversations.find((item) => item.externalId === "p1-ru-001");
  assert.ok(conversation);
  const evaluationId = useCqa.getState().evaluateRules(conversation.id);
  assert.ok(evaluationId);
  const before = useCqa.getState().evaluations.find((item) => item.id === evaluationId)!;
  assert.equal(before.source, "heuristic");
  const baseAnswer = before.baseResults.find((item) => item.criterionId === "C01")!.answer;
  assert.equal(useCqa.getState().submitAppeal(evaluationId, "C01", "Приветствие было у клиента, не у оператора."), null);
  const appeal = useCqa.getState().appeals[0]!;
  const next = baseAnswer === "yes" ? "no" : "yes";
  assert.equal(useCqa.getState().decideAppeal(appeal.id, "overridden", "В первой реплике оператора нет представления.", next), null);
  const after = useCqa.getState().evaluations.find((item) => item.id === evaluationId)!;
  assert.equal(after.baseResults.find((item) => item.criterionId === "C01")!.answer, baseAnswer);
  assert.equal(after.finalResults.find((item) => item.criterionId === "C01")!.answer, next);
  assert.equal(after.baseTotal, before.baseTotal);
  assert.equal(useCqa.getState().decideAppeal(appeal.id, "confirmed", "Повторное решение не принимается."), "Решение уже сохранено");
  const snapshot = useCqa.getState().exportSnapshot();
  useCqa.getState().resetLocal();
  assert.equal(useCqa.getState().importSnapshot(snapshot), null);
  assert.ok(useCqa.getState().decisions.some((item) => item.appealId === appeal.id));
  assert.equal(useCqa.getState().evaluations.find((item) => item.id === evaluationId)?.baseResults.find((item) => item.criterionId === "C01")?.answer, baseAnswer);
});

test("demo dialogues are not the organizer DEV group", () => {
  useCqa.getState().resetLocal();
  const demo = useCqa.getState().conversations.filter((item) => item.origin === "demo");
  assert.equal(demo.length, 14);
  assert.ok(demo.every((item) => item.datasetGroupId === "DEMO" && item.id.startsWith("DEMO::")));
  assert.equal(parseMediaOffset("01:30"), 90);
  assert.equal(parseMediaOffset("1:02:03"), 3723);
  assert.equal(parseMediaOffset("2026-11-06T10:15:02+05:00"), null);
});
