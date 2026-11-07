import assert from "node:assert/strict";
import test from "node:test";
import { assemble } from "./engine.ts";
import type { DraftAnswer } from "./engine.ts";
import { parseImport } from "./engine.ts";
import { rulesDrafts } from "./rules.ts";
import { officialCriteria } from "./seed.ts";
import { applySemanticVerdicts, contextWindows, judgePrompt, parseJudgeResponse, scoringPrompt } from "./semantic-judge.ts";
import { useCqa } from "./store.ts";
import type { Answer, Criterion, TranscriptMessage } from "./types.ts";

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

function baseline(lines: TranscriptMessage[], over: Partial<Record<string, DraftAnswer>> = {}) {
  const drafts = officialCriteria.map((criterion) => {
    if (over[criterion.id]) return over[criterion.id]!;
    if (criterion.answerType === "scale") return draft(criterion, 0, [], { from: 0, to: lines.length - 1 });
    if (criterion.answerType === "yes_no_na") return draft(criterion, "no", [], { from: 0, to: lines.length - 1 });
    return draft(criterion, "no", [], { from: 0, to: lines.length - 1 });
  });
  return assemble(officialCriteria, lines, drafts);
}

function contradict(lines: TranscriptMessage[], over: Partial<Record<string, DraftAnswer>>, id: string, explanation: string) {
  const assembled = baseline(lines, over);
  const before = assembled.results.find((item) => item.criterionId === id)!;
  const judged = applySemanticVerdicts(
    assembled,
    assembled.results.map((result) => ({
      criterionId: result.criterionId,
      status: result.criterionId === id ? "invalid" : "valid",
      explanation: result.criterionId === id ? explanation : "Ответ согласован с рубрикой этой версии.",
    })),
  );
  const after = judged.results.find((item) => item.criterionId === id)!;
  assert.equal(after.answer, before.answer);
  assert.equal(after.validationStatus, "invalid_evidence");
  assert.equal(judged.status, "needs_review");
  assert.equal(judged.outcome.critical, false);
  return judged;
}

test("judge context of a long dialog keeps the ending and original indexes", () => {
  const lines: TranscriptMessage[] = Array.from({ length: 24 }, (_, index) => ({
    messageIndex: index,
    timestampRaw: `00:${String(index).padStart(2, "0")}`,
    speaker: index % 2 === 0 ? "client" : "operator",
    text: index === 23 ? "До свидания, хорошего дня." : `реплика ${index}`,
  }));
  const criterion = officialCriteria.find((item) => item.id === "C07")!;
  const item = {
    criterion,
    answer: "yes" as const,
    reason: "Прощание есть в последней реплике оператора.",
    naReason: null,
    evidence: [{ messageIndex: 23, quote: "До свидания", speaker: "operator", timestampRaw: "00:23" }],
    checkedRange: { from: 0, to: 23 },
  };
  const windows = contextWindows(lines, item);
  assert.equal(windows.length, 2);
  assert.equal(windows[0]?.[0]?.messageIndex, 0);
  assert.equal(windows[0]?.length, 16);
  assert.equal(windows[1]?.at(-1)?.messageIndex, 23);
  assert.equal(windows[1]?.some((message) => message.messageIndex === 16), true);
  const prompt = judgePrompt([item], lines);
  assert.match(prompt, /\[23\] 00:23 operator: До свидания, хорошего дня\./);
  assert.match(prompt, /\[16\]/);
  assert.match(prompt, /фрагмент 2\/2/);
  assert.doesNotMatch(prompt, /\[24\]/);
});

test("technical check keeps a real quote and does not rewrite the transcript", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Нужна комиссия." },
    { messageIndex: 1, timestampRaw: "00:04", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим." },
  ];
  const copy = lines.map((item) => item.text);
  const c01 = officialCriteria.find((item) => item.id === "C01")!;
  const assembled = baseline(lines, {
    C01: draft(c01, "yes", [{ messageIndex: 1, quote: "Меня зовут Айгерим" }], null),
  });
  const evidence = assembled.results.find((item) => item.criterionId === "C01")?.evidence[0];
  assert.equal(evidence?.speaker, "operator");
  assert.equal(evidence?.timestampRaw, "00:04");
  assert.equal(evidence?.messageIndex, 1);
  assert.deepEqual(lines.map((item) => item.text), copy);
});

test("C01 false No stays No", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Нужна комиссия тарифа." },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим." },
  ];
  const c01 = officialCriteria.find((item) => item.id === "C01")!;
  const judged = contradict(lines, { C01: draft(c01, "no", [], { from: 0, to: 1 }) }, "C01", "в первой реплике есть приветствие и представление");
  assert.equal(judged.results.find((item) => item.criterionId === "C01")?.answer, "no");
});

test("C03 confirmed identity scored No stays No", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Какой статус вывода по заявке?" },
    { messageIndex: 1, timestampRaw: "00:20", speaker: "operator", text: "Личность подтверждена. На вашем счёте 430000 тенге." },
  ];
  const c03 = officialCriteria.find((item) => item.id === "C03")!;
  const judged = contradict(lines, { C03: draft(c03, "no", [], { from: 0, to: 1 }) }, "C03", "личность подтверждена до раскрытия счёта");
  assert.equal(judged.results.find((item) => item.criterionId === "C03")?.answer, "no");
});

test("C03 disclosure without identification is not a valid N/A", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Скажите остаток." },
    { messageIndex: 1, timestampRaw: "00:06", speaker: "operator", text: "Баланс: 15000 тенге." },
  ];
  const c03 = officialCriteria.find((item) => item.id === "C03")!;
  const judged = contradict(lines, { C03: draft(c03, "na", [], null) }, "C03", "защищённые сведения раскрыты без подтверждения личности");
  assert.equal(judged.results.find((item) => item.criterionId === "C03")?.answer, "na");
});

test("C07 proper closing scored No stays No", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Нужна комиссия тарифа." },
    { messageIndex: 1, timestampRaw: "00:09", speaker: "operator", text: "Итого комиссия 0,3%. Могу ещё чем-то помочь. Хорошего дня!" },
  ];
  const c07 = officialCriteria.find((item) => item.id === "C07")!;
  const judged = contradict(lines, { C07: draft(c07, "no", [], { from: 0, to: 1 }) }, "C07", "есть итог и прощание");
  assert.equal(judged.results.find((item) => item.criterionId === "C07")?.answer, "no");
});

test("C08 insult scored No stays No and does not raise the flag", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Нужна комиссия." },
    { messageIndex: 1, timestampRaw: "00:04", speaker: "operator", text: "Вы идиот, зря отнимаете время." },
  ];
  const c08 = officialCriteria.find((item) => item.id === "C08")!;
  const judged = contradict(lines, { C08: draft(c08, "no", [], { from: 0, to: 1 }) }, "C08", "в реплике оператора есть оскорбление клиента");
  assert.equal(judged.results.find((item) => item.criterionId === "C08")?.answer, "no");
});

test("official free Telegram channel is not auto-promoted to a bypass", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Где ваши новости?" },
    { messageIndex: 1, timestampRaw: "00:06", speaker: "operator", text: "Наш официальный бесплатный Telegram-канал: t.me/freedombroker" },
  ];
  const c08 = officialCriteria.find((item) => item.id === "C08")!;
  const judged = contradict(
    lines,
    { C08: draft(c08, "yes", [{ messageIndex: 1, quote: "официальный бесплатный Telegram-канал" }], null) },
    "C08",
    "бесплатный официальный канал не является платной услугой в обход компании",
  );
  assert.equal(judged.results.find((item) => item.criterionId === "C08")?.answer, "yes");
});

test("confidential disclosure scored No stays No", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Это мой паспорт?" },
    { messageIndex: 1, timestampRaw: "00:05", speaker: "operator", text: "Нет, это паспорт другого клиента: 1234 567890." },
  ];
  const c08 = officialCriteria.find((item) => item.id === "C08")!;
  const judged = contradict(lines, { C08: draft(c08, "no", [], { from: 0, to: 1 }) }, "C08", "раскрыты данные другого клиента");
  assert.equal(judged.results.find((item) => item.criterionId === "C08")?.answer, "no");
});

test("C02 N/A is kept when the judge accepts a complete request", () => {
  const lines: TranscriptMessage[] = [
    { messageIndex: 0, timestampRaw: "00:01", speaker: "client", text: "Подскажите комиссию тарифа Стандарт по акциям США." },
    { messageIndex: 1, timestampRaw: "00:08", speaker: "operator", text: "Комиссия 0,3%." },
  ];
  const c02 = officialCriteria.find((item) => item.id === "C02")!;
  const assembled = baseline(lines, { C02: draft(c02, "na", [], null) });
  const judged = applySemanticVerdicts(
    assembled,
    assembled.results.map((result) => ({
      criterionId: result.criterionId,
      status: "valid" as const,
      explanation: "Данных для ответа хватало с начала, N/A согласован с рубрикой.",
    })),
  );
  assert.equal(judged.results.find((item) => item.criterionId === "C02")?.answer, "na");
  assert.equal(judged.status, "completed");
});

test("a rewritten criterion is judged by its new rubric, not by the old C01 meaning", () => {
  const official = officialCriteria.find((item) => item.id === "C01")!;
  const rewritten: Criterion = {
    ...official,
    title: "Номер заявки",
    rubric: "ДА, если оператор назвал номер заявки. Приветствие не оценивается.",
  };
  const lines: TranscriptMessage[] = [
    { messageIndex: 4, timestampRaw: "00:09", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим." },
  ];
  const prompt = judgePrompt(
    [{
      criterion: rewritten,
      answer: "yes",
      reason: "оператор поздоровался и назвал имя",
      naReason: null,
      evidence: [{ messageIndex: 4, quote: "Меня зовут Айгерим", speaker: "operator", timestampRaw: "00:09" }],
      checkedRange: null,
    }],
    lines,
  );
  assert.match(prompt, /номер заявки/);
  assert.match(prompt, /00:09/);
  assert.doesNotMatch(prompt, /представился/);
  assert.match(official.rubric, /представился/);
  const custom: Criterion = {
    id: "X01",
    title: "Номер заявки",
    section: "custom",
    weight: 10,
    answerType: "yes_no",
    naAllowed: false,
    rubric: "ДА, если оператор назвал номер заявки. Это не критерий приветствия.",
  };
  const customPrompt = scoringPrompt(
    [custom],
    { id: "STUDY::x", datasetGroupId: "STUDY", externalId: "x", channel: "agent chat", language: "RU", audioUrl: null, origin: "study", messages: lines },
  );
  assert.match(customPrompt, /X01/);
  assert.match(customPrompt, /номер заявки/);
  assert.doesNotMatch(customPrompt, /C01 ДА только если/);
});

test("judge payload contract accepts valid, invalid and needs_review without inventing certainty", () => {
  const parsed = parseJudgeResponse(
    {
      verdicts: [
        { criterion_id: "C01", status: "invalid", explanation: "ответ не подтверждён" },
        { criterion_id: "C02", status: "needs_review", explanation: "контекста недостаточно" },
        { criterion_id: "C03", status: "valid", explanation: "согласовано с рубрикой" },
      ],
    },
    ["C01", "C02", "C03", "C04"],
  );
  assert.equal(parsed.verdicts.find((item) => item.criterionId === "C01")?.status, "invalid");
  assert.equal(parsed.verdicts.find((item) => item.criterionId === "C02")?.status, "needs_review");
  assert.equal(parsed.verdicts.find((item) => item.criterionId === "C03")?.status, "valid");
  assert.ok(parsed.errors.some((error) => error.startsWith("C04")));
  const broken = parseJudgeResponse({ note: "нет" }, ["C01"]);
  assert.equal(broken.verdicts.length, 0);
  assert.match(broken.errors.join(" "), /verdicts/);
});

test("jury path keeps official v1 and scores the edited rubric on the next dialog", () => {
  useCqa.getState().resetLocal();
  const officialRubric = officialCriteria.find((item) => item.id === "C01")!.rubric;
  const parsed = parseImport(
    {
      isSuccess: true,
      error: "",
      data: {
        dataset_group_id: "DEV",
        total_records: 1,
        records: [{
          conversation_id: "dev-jury-1",
          channel: "agent chat",
          language: "RU",
          transcript: [
            { timestamp: "00:01", speaker: "client", text: "Где номер заявки?" },
            { timestamp: "00:08", speaker: "operator", text: "Здравствуйте! Меня зовут Айгерим. Заявка 5512." },
          ],
        }],
      },
    },
    "DEV",
    "organizer",
  );
  assert.equal(useCqa.getState().importConversations(parsed.conversations, "API DEV").added, 1);
  const conversation = useCqa.getState().conversations.find((item) => item.externalId === "dev-jury-1")!;
  assert.equal(conversation.origin, "organizer");
  assert.notEqual(conversation.datasetGroupId, "STUDY");
  const version = useCqa.getState().versions.find((item) => item.official)!;
  const drafts = rulesDrafts(version.criteria, conversation);
  const assembled = assemble(version.criteria, conversation.messages, drafts);
  const savedId = useCqa.getState().saveModelEvaluation(
    {
      conversationId: conversation.id,
      checklistVersionId: version.id,
      configHash: version.configHash,
      modelId: "grok-4.5",
      promptVersion: "cqa-s5-v4",
      startedAt: "2026-11-07T10:00:00.000Z",
    },
    {
      status: assembled.status,
      results: assembled.results,
      total: assembled.outcome.total,
      raw: assembled.outcome.raw,
      critical: assembled.outcome.critical,
      model: "grok-4.5",
      promptVersion: "cqa-s5-v4",
      usage: { promptTokens: 20, completionTokens: 10, estimatedCostUsd: 0, calls: 1 },
      trace: ["judge C01: valid"],
    },
  );
  assert.ok(savedId);
  const base = useCqa.getState().evaluations.find((item) => item.id === savedId)!;
  assert.equal(base.source, "ai");
  const baseAnswer = base.baseResults.find((item) => item.criterionId === "C04")!.answer;
  assert.equal(useCqa.getState().submitAppeal(savedId, "C04", "Консультация разобрана неполно."), null);
  const appeal = useCqa.getState().appeals[0]!;
  const next = typeof baseAnswer === "number" && baseAnswer >= 10 ? 5 : 10;
  assert.equal(useCqa.getState().decideAppeal(appeal.id, "overridden", "Оставлен открытый вопрос по заявке.", next), null);
  const after = useCqa.getState().evaluations.find((item) => item.id === savedId)!;
  assert.equal(after.baseResults.find((item) => item.criterionId === "C04")!.answer, baseAnswer);
  assert.equal(after.finalResults.find((item) => item.criterionId === "C04")!.answer, next);
  assert.equal(useCqa.getState().decideAppeal(appeal.id, "confirmed", "Повтор не принимается.", next), "Решение уже сохранено");

  const edited = version.criteria.map((criterion) =>
    criterion.id === "C01"
      ? { ...criterion, rubric: "ДА, если оператор назвал номер заявки. Приветствие не оценивается." }
      : criterion,
  );
  assert.deepEqual(useCqa.getState().saveVersion(edited), []);
  assert.equal(officialCriteria.find((item) => item.id === "C01")!.rubric, officialRubric);
  assert.equal(
    useCqa.getState().versions.find((item) => item.id === version.id)!.criteria.find((item) => item.id === "C01")!.rubric,
    officialRubric,
  );
  const active = useCqa.getState().versions.find((item) => item.id === useCqa.getState().activeVersionId)!;
  assert.notEqual(active.id, version.id);
  const prompt = scoringPrompt(active.criteria, conversation);
  assert.match(prompt, /номер заявки/);
  assert.doesNotMatch(prompt, /представился/);
  const rebound = rulesDrafts(active.criteria, conversation);
  assert.equal(rebound.find((item) => item.criterionId === "C01")?.unbound, true);
  const second = assemble(active.criteria, conversation.messages, rebound);
  assert.notEqual(second.status, "completed");
  assert.match(second.errors.join(" "), /старая семантика идентификатора не применяется/);
});
