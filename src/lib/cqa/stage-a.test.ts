import assert from "node:assert/strict";
import test from "node:test";
import { assemble, type DraftAnswer } from "./engine.ts";
import { expectedRange } from "./evidence.ts";
import { officialCriteria, officialVersion } from "./seed.ts";
import { useCqa } from "./store.ts";
import type { Answer, ChecklistVersion, Criterion, Evaluation, TranscriptMessage } from "./types.ts";

function draft(
  criterion: Criterion,
  answer: Answer,
  quotes: DraftAnswer["quotes"] = [],
  range: DraftAnswer["checkedRange"] = null,
  naReason: string | null = null,
): DraftAnswer {
  return {
    criterionId: criterion.id,
    answer,
    reason: "Обоснование решения в рамках тестирования этапа А.",
    quotes,
    checkedRange: answer === "na" ? null : range,
    naReason: answer === "na" ? (naReason ?? "Критерий неприменим по рубрике диалога") : null,
  };
}

function validDrafts(
  criteria: Criterion[],
  messages: TranscriptMessage[],
  overrides: Partial<Record<string, DraftAnswer>> = {},
): DraftAnswer[] {
  const opMsg = messages.find((m) => m.speaker === "operator") ?? messages[messages.length - 1]!;
  const opQuote = opMsg.text.slice(0, 30);
  const fullRange = { from: messages[0]!.messageIndex, to: messages[messages.length - 1]!.messageIndex };

  return criteria.map((c) => {
    if (overrides[c.id]) return overrides[c.id]!;
    if (c.id === "C01") {
      return draft(c, "yes", [{ messageIndex: opMsg.messageIndex, quote: opQuote }], null);
    }
    if (c.id === "C02") {
      return draft(c, "na", [], null, "Данных для ответа было достаточно изначально.");
    }
    if (c.id === "C03") {
      return draft(c, "na", [], null, "Запрос не требовал проверки личности.");
    }
    if (c.id === "C04") {
      return draft(c, 20, [{ messageIndex: opMsg.messageIndex, quote: opQuote }], null);
    }
    if (c.id === "C05") {
      return draft(c, "yes", [{ messageIndex: opMsg.messageIndex, quote: opQuote }], null);
    }
    if (c.id === "C06") {
      return draft(c, 10, [{ messageIndex: opMsg.messageIndex, quote: opQuote }], null);
    }
    if (c.id === "C07") {
      return draft(c, "no", [], fullRange);
    }
    if (c.id === "C08") {
      return draft(c, "no", [], fullRange);
    }
    return draft(c, "no", [], fullRange);
  });
}

test("клиент поздоровался, оператор нет, C01=ДА с цитатой клиента → не completed", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте! Подскажите мой баланс." },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Секунду, проверяю информацию по вашему счёту." },
  ];
  const c01 = officialCriteria.find((c) => c.id === "C01")!;
  const assembled = assemble(
    officialCriteria,
    lines,
    validDrafts(officialCriteria, lines, {
      C01: draft(c01, "yes", [{ messageIndex: 0, quote: "Здравствуйте" }], null),
    }),
  );
  const result = assembled.results.find((item) => item.criterionId === "C01");
  assert.notEqual(assembled.status, "completed");
  assert.equal(result?.validationStatus, "invalid_evidence");
  assert.match(assembled.errors.join(" "), /не подтверждает действие оператора/);
});

test("C03=ДА с цитатой system «личность подтверждена» до раскрытия баланса → completed", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте! Какой у меня остаток на брокерском счёте?" },
    { messageIndex: 1, timestampRaw: "00:03", speaker: "system", text: "Личность подтверждена через Freedom ID." },
    { messageIndex: 2, timestampRaw: "00:06", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Ваш баланс 150000 тенге." },
  ];
  const c03 = officialCriteria.find((c) => c.id === "C03")!;
  const assembled = assemble(
    officialCriteria,
    lines,
    validDrafts(officialCriteria, lines, {
      C03: draft(c03, "yes", [{ messageIndex: 1, quote: "Личность подтверждена" }], null),
    }),
  );
  const result = assembled.results.find((item) => item.criterionId === "C03");
  assert.equal(result?.validationStatus, "ok");
  assert.equal(assembled.status, "completed");
});

test("C03=ДА с цитатой client → не completed", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте! Личность подтверждена, я Иванов Иван." },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Ваш баланс 5000 тенге." },
  ];
  const c03 = officialCriteria.find((c) => c.id === "C03")!;
  const assembled = assemble(
    officialCriteria,
    lines,
    validDrafts(officialCriteria, lines, {
      C03: draft(c03, "yes", [{ messageIndex: 0, quote: "Личность подтверждена" }], null),
    }),
  );
  const result = assembled.results.find((item) => item.criterionId === "C03");
  assert.notEqual(assembled.status, "completed");
  assert.equal(result?.validationStatus, "invalid_evidence");
  assert.match(assembled.errors.join(" "), /не подтверждает действие оператора/);
});

test("C08=ДА с цитатой system → не completed", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте!" },
    { messageIndex: 1, timestampRaw: "00:02", speaker: "system", text: "Обнаружена подозрительная активность." },
    { messageIndex: 2, timestampRaw: "00:05", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим, Freedom Broker." },
  ];
  const c08 = officialCriteria.find((c) => c.id === "C08")!;
  const assembled = assemble(
    officialCriteria,
    lines,
    validDrafts(officialCriteria, lines, {
      C08: draft(c08, "yes", [{ messageIndex: 1, quote: "подозрительная активность" }], null),
    }),
  );
  const result = assembled.results.find((item) => item.criterionId === "C08");
  assert.notEqual(assembled.status, "completed");
  assert.equal(result?.validationStatus, "invalid_evidence");
  assert.match(assembled.errors.join(" "), /не подтверждает нарушение оператора/);
});

test("C01=НЕТ без checked_range → диапазон заканчивается на первой реплике оператора", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте" },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Чем помочь?" },
    { messageIndex: 2, timestampRaw: "00:10", speaker: "client", text: "Нужна справка" },
    { messageIndex: 3, timestampRaw: "00:15", speaker: "operator", text: "Оформляю справку" },
  ];
  const c01 = officialCriteria.find((c) => c.id === "C01")!;
  const assembled = assemble(
    officialCriteria,
    lines,
    validDrafts(officialCriteria, lines, {
      C01: draft(c01, "no", [], null),
    }),
  );
  const result = assembled.results.find((item) => item.criterionId === "C01");
  assert.equal(result?.answer, "no");
  assert.deepEqual(result?.checkedRange, { from: 0, to: 1 });
});

test("C02: ожидаемый диапазон от начала до первого содержательного ответа оператора, иначе весь диалог", () => {
  const c02 = officialCriteria.find((c) => c.id === "C02")!;
  const withSubstantive: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте, какая комиссия за вывод?" },
    { messageIndex: 1, timestampRaw: "00:03", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Чем могу помочь?" },
    { messageIndex: 2, timestampRaw: "00:05", speaker: "operator", text: "Минуту, пожалуйста, проверяю информацию." },
    { messageIndex: 3, timestampRaw: "00:08", speaker: "operator", text: "Комиссия за вывод составляет 0.3% от суммы." },
    { messageIndex: 4, timestampRaw: "00:10", speaker: "client", text: "Спасибо большое!" },
  ];
  const rangeSubstantive = expectedRange(withSubstantive, c02);
  assert.deepEqual(rangeSubstantive, { from: 0, to: 3 });

  const withoutSubstantive: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте" },
    { messageIndex: 1, timestampRaw: "00:03", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Чем могу помочь?" },
    { messageIndex: 2, timestampRaw: "00:05", speaker: "client", text: "Уже не надо, спасибо" },
  ];
  const rangeFull = expectedRange(withoutSubstantive, c02);
  assert.deepEqual(rangeFull, { from: 0, to: 2 });
});

test("C07=НЕТ → диапазон включает конец диалога", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте" },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим." },
    { messageIndex: 2, timestampRaw: "00:10", speaker: "client", text: "Спасибо за ответ." },
    { messageIndex: 3, timestampRaw: "00:12", speaker: "operator", text: "Пожалуйста." },
  ];
  const c07 = officialCriteria.find((c) => c.id === "C07")!;
  const assembled = assemble(
    officialCriteria,
    lines,
    validDrafts(officialCriteria, lines, {
      C07: draft(c07, "no", [], null),
    }),
  );
  const result = assembled.results.find((item) => item.criterionId === "C07");
  assert.equal(result?.answer, "no");
  assert.deepEqual(result?.checkedRange, { from: 1, to: 3 });
  assert.equal(result?.checkedRange?.to, 3);
});

test("C07=ДА с цитатой system → не completed", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте, вопрос решён, спасибо." },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Рада была помочь." },
    { messageIndex: 2, timestampRaw: "00:06", speaker: "system", text: "Чат закрыт клиентом." },
  ];
  const c07 = officialCriteria.find((c) => c.id === "C07")!;
  const assembled = assemble(
    officialCriteria,
    lines,
    validDrafts(officialCriteria, lines, {
      C07: draft(c07, "yes", [{ messageIndex: 2, quote: "Чат закрыт клиентом" }], null),
    }),
  );
  const result = assembled.results.find((item) => item.criterionId === "C07");
  assert.notEqual(assembled.status, "completed");
  assert.equal(result?.validationStatus, "invalid_evidence");
  assert.match(assembled.errors.join(" "), /не подтверждает действие оператора/);
});

test("C07=ДА с прощанием operator → completed", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте, вопрос решён, спасибо." },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Рада была помочь, всего доброго, до свидания!" },
  ];
  const c07 = officialCriteria.find((c) => c.id === "C07")!;
  const assembled = assemble(
    officialCriteria,
    lines,
    validDrafts(officialCriteria, lines, {
      C07: draft(c07, "yes", [{ messageIndex: 1, quote: "до свидания" }], null),
    }),
  );
  const result = assembled.results.find((item) => item.criterionId === "C07");
  assert.equal(result?.validationStatus, "ok");
  assert.equal(assembled.status, "completed");
});

test("изменённая рубрика C01 → весь диалог", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Здравствуйте" },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Чем помочь?" },
    { messageIndex: 2, timestampRaw: "00:10", speaker: "client", text: "Нужна справка" },
    { messageIndex: 3, timestampRaw: "00:15", speaker: "operator", text: "Оформляю справку" },
  ];
  const c01 = officialCriteria.find((c) => c.id === "C01")!;
  const customC01: Criterion = {
    ...c01,
    rubric: "Кастомная формулировка рубрики C01, отличающаяся от официальной в seed.",
  };
  const customCriteria = officialCriteria.map((c) => (c.id === "C01" ? customC01 : c));

  const assembled = assemble(
    customCriteria,
    lines,
    validDrafts(customCriteria, lines, {
      C01: draft(customC01, "no", [], null),
    }),
  );
  const result = assembled.results.find((item) => item.criterionId === "C01");
  assert.equal(result?.answer, "no");
  assert.deepEqual(result?.checkedRange, { from: 0, to: 3 });
});

test("store merge: старая оценка перепривязывается к архивной версии, апелляция пересчитывается по старым критериям, новая оценка — к новой версии", () => {
  const currentOfficial = officialVersion();
  const legacyHash = "deadbeefcafebabe";
  const legacyCriteria: Criterion[] = officialCriteria.map((c) =>
    c.id === "C01" ? { ...c, weight: 30 } : { ...c, evidenceSpeakers: undefined },
  );
  const legacyVersion: ChecklistVersion = {
    id: currentOfficial.id,
    name: "Чек-лист чатов (старый)",
    versionNumber: 1,
    label: "Официальный S5 (прежний)",
    createdAt: "2026-11-01T00:00:00.000Z",
    official: true,
    rounding: "HALF_UP",
    criteria: legacyCriteria,
    configHash: legacyHash,
  };
  const legacyEvalId = "ev-legacy-1";
  const legacyEvaluation: Evaluation = {
    id: legacyEvalId,
    conversationId: "c1",
    checklistVersionId: legacyVersion.id,
    configHash: legacyHash,
    model: "test-model",
    promptVersion: "v1",
    startedAt: "2026-11-01T12:00:00.000Z",
    createdAt: "2026-11-01T12:00:05.000Z",
    source: "ai",
    status: "completed",
    baseTotal: 70,
    baseRaw: 70,
    baseCritical: false,
    baseResults: [
      {
        criterionId: "C01",
        answer: "no",
        reason: "Нет приветствия",
        evidence: [],
        checkedRange: { from: 0, to: 1 },
        naReason: null,
        validationStatus: "ok",
        weight: 30,
        normalized: 0,
        contribution: 0,
        isNa: false,
        critical: false,
      },
    ],
    finalTotal: 70,
    finalRaw: 70,
    finalCritical: false,
    finalResults: [
      {
        criterionId: "C01",
        answer: "no",
        reason: "Нет приветствия",
        evidence: [],
        checkedRange: { from: 0, to: 1 },
        naReason: null,
        validationStatus: "ok",
        weight: 30,
        normalized: 0,
        contribution: 0,
        isNa: false,
        critical: false,
      },
    ],
    usage: null,
    trace: [],
  };

  const fakePersisted = {
    versions: [legacyVersion],
    activeVersionId: legacyVersion.id,
    evaluations: [legacyEvaluation],
  };

  const persistOptions = (useCqa as unknown as { persist: { getOptions: () => { merge: (persisted: unknown, current: unknown) => unknown } } }).persist.getOptions();
  const merged = persistOptions.merge(fakePersisted, {
    versions: [currentOfficial],
    activeVersionId: currentOfficial.id,
    conversations: [
      {
        id: "c1",
        datasetGroupId: "G1",
        externalId: "ext-1",
        channel: "chat",
        language: "RU",
        audioUrl: null,
        messages: [{ messageIndex: 0, timestampRaw: "00:01", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим." }],
      },
    ],
    evaluations: [],
    appeals: [],
    decisions: [],
    jobs: [],
    role: "analyst",
    importNote: "",
  }) as { versions: ChecklistVersion[]; evaluations: Evaluation[]; activeVersionId: string };

  const archiveId = `${currentOfficial.id}-${legacyHash.slice(0, 6)}`;

  // 1. Старая оценка теперь указывает на архивную версию с прежними критериями и прежним hash
  assert.equal(merged.evaluations[0]!.checklistVersionId, archiveId);
  assert.equal(merged.evaluations[0]!.configHash, legacyHash);
  const archivedVer = merged.versions.find((v) => v.id === archiveId);
  assert.ok(archivedVer);
  assert.equal(archivedVer?.criteria.find((c) => c.id === "C01")?.weight, 30);

  // 2. Активной версией становится новая официальная
  assert.equal(merged.activeVersionId, currentOfficial.id);

  // 3. Загружаем merged в store и проверяем апелляцию и создание новой оценки
  useCqa.setState({
    versions: merged.versions,
    activeVersionId: merged.activeVersionId,
    conversations: [
      {
        id: "c1",
        datasetGroupId: "G1",
        externalId: "ext-1",
        channel: "chat",
        language: "RU",
        audioUrl: null,
        messages: [{ messageIndex: 0, timestampRaw: "00:01", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим." }],
      },
    ],
    evaluations: merged.evaluations,
    appeals: [],
    decisions: [],
  });

  const errAppeal = useCqa.getState().submitAppeal(legacyEvalId, "C01", "Оператор поздоровался в начале");
  assert.equal(errAppeal, null);
  const appealId = useCqa.getState().appeals[0]!.id;
  const errDecide = useCqa.getState().decideAppeal(appealId, "overridden", "Приветствие было найдено", "yes");
  assert.equal(errDecide, null);

  const updatedLegacy = useCqa.getState().evaluations.find((e) => e.id === legacyEvalId)!;
  const c01Final = updatedLegacy.finalResults.find((r) => r.criterionId === "C01");
  assert.equal(c01Final?.answer, "yes");
  assert.equal(c01Final?.weight, 30);

  // 4. Новая оценка привязывается к новой официальной версии
  const newEvalId = useCqa.getState().saveModelEvaluation(
    {
      conversationId: "c1",
      checklistVersionId: currentOfficial.id,
      configHash: currentOfficial.configHash,
      modelId: "test-model",
      promptVersion: "v1",
      startedAt: new Date().toISOString(),
    },
    {
      status: "completed",
      results: [],
      total: 100,
      raw: 100,
      critical: false,
      model: "test-model",
      promptVersion: "v1",
      usage: null,
      trace: [],
    },
  );
  assert.ok(newEvalId);
  const newEval = useCqa.getState().evaluations.find((e) => e.id === newEvalId);
  assert.equal(newEval?.checklistVersionId, currentOfficial.id);
  assert.equal(newEval?.configHash, currentOfficial.configHash);
});

test("store merge: повторный merge (вторая загрузка) ничего не дублирует и не перепривязывает повторно", () => {
  const currentOfficial = officialVersion();
  const legacyHash = "deadbeefcafebabe";
  const archiveId = `${currentOfficial.id}-${legacyHash.slice(0, 6)}`;
  const archivedVersion: ChecklistVersion = {
    id: archiveId,
    name: "Чек-лист чатов (старый)",
    versionNumber: 1,
    label: "Официальный S5 (прежний)",
    createdAt: "2026-11-01T00:00:00.000Z",
    official: false,
    rounding: "HALF_UP",
    criteria: officialCriteria,
    configHash: legacyHash,
  };
  const remappedEvaluation: Evaluation = {
    id: "ev-legacy-1",
    conversationId: "c1",
    checklistVersionId: archiveId,
    configHash: legacyHash,
    model: "test-model",
    promptVersion: "v1",
    startedAt: "2026-11-01T12:00:00.000Z",
    createdAt: "2026-11-01T12:00:05.000Z",
    source: "ai",
    status: "completed",
    baseTotal: 90,
    baseRaw: 90,
    baseCritical: false,
    baseResults: [],
    finalTotal: 90,
    finalRaw: 90,
    finalCritical: false,
    finalResults: [],
    usage: null,
    trace: [],
  };

  const stateAfterFirstMerge = {
    versions: [currentOfficial, archivedVersion],
    activeVersionId: currentOfficial.id,
    evaluations: [remappedEvaluation],
    jobs: [],
  };

  const persistOptions = (useCqa as unknown as { persist: { getOptions: () => { merge: (persisted: unknown, current: unknown) => unknown } } }).persist.getOptions();
  const secondMerge = persistOptions.merge(stateAfterFirstMerge, {
    versions: [currentOfficial],
    activeVersionId: currentOfficial.id,
    conversations: [],
    evaluations: [],
    appeals: [],
    decisions: [],
    jobs: [],
    role: "analyst",
    importNote: "",
  }) as { versions: ChecklistVersion[]; evaluations: Evaluation[]; activeVersionId: string };

  assert.equal(secondMerge.versions.length, 2);
  assert.deepEqual(secondMerge.versions.map((v) => v.id), [currentOfficial.id, archiveId]);
  assert.equal(secondMerge.evaluations.length, 1);
  assert.equal(secondMerge.evaluations[0]!.checklistVersionId, archiveId);
  assert.equal(secondMerge.evaluations[0]!.configHash, legacyHash);
  assert.equal(secondMerge.activeVersionId, currentOfficial.id);
});
