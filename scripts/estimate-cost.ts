import { buildDemo } from "../src/lib/cqa/demo.ts";
import { controlCases } from "../src/lib/cqa/control.ts";
import { officialCriteria } from "../src/lib/cqa/seed.ts";
import { scoringPrompt, judgePrompt, type JudgeCase } from "../src/lib/cqa/semantic-judge.ts";
import { INPUT_USD_PER_M, OUTPUT_USD_PER_M } from "../src/lib/cqa/types.ts";
import type { Conversation } from "../src/lib/cqa/types.ts";

interface TokenEstimate {
  chars: number;
  cyrillicChars: number;
  otherChars: number;
  tokens: number;
}

function estimateTokens(text: string): TokenEstimate {
  const chars = text.length;
  const cyrillicChars = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const otherChars = chars - cyrillicChars;
  // Приближение: кириллица ~3 символа на токен, латиница/пробелы/пунктуация ~4 символа на токен
  const tokens = Math.ceil(cyrillicChars / 3 + otherChars / 4);
  return { chars, cyrillicChars, otherChars, tokens };
}

function calculateCostUsd(inputTokens: number, outputTokens: number): number {
  const usd = (inputTokens / 1_000_000) * INPUT_USD_PER_M + (outputTokens / 1_000_000) * OUTPUT_USD_PER_M;
  return Math.round(usd * 10_000) / 10_000;
}

function makeJudgeCases(conversation: Conversation, answers?: Record<string, string | number>): JudgeCase[] {
  const messages = conversation.messages;
  const opMsg = messages.find((m) => m.speaker === "operator");
  return officialCriteria.map((criterion) => {
    const ans = answers?.[criterion.id] ?? (criterion.answerType === "scale" ? 15 : "yes");
    const quote = opMsg ? opMsg.text.slice(0, 40) : "";
    return {
      criterion,
      answer: ans,
      reason: "Обоснование модели для оценки стоимости промпта",
      naReason: ans === "na" ? "Критерий не применим к диалогу" : null,
      evidence: opMsg
        ? [
            {
              messageIndex: opMsg.messageIndex,
              quote,
              speaker: opMsg.speaker,
              timestampRaw: opMsg.timestampRaw,
            },
          ]
        : [],
      checkedRange: { from: 0, to: Math.min(messages.length - 1, 2) },
    };
  });
}

interface DialogEstimate {
  id: string;
  group: "demo" | "study";
  lang: string;
  msgCount: number;
  scorePromptChars: number;
  scoreInputTokens: number;
  judgePromptChars: number;
  judgeInputTokens: number;
  totalPassInputTokens: number;
  passOutputTokens: number;
  minCostUsd: number;
  maxCostUsd: number;
}

function analyzeDialog(conversation: Conversation, group: "demo" | "study", answers?: Record<string, string | number>): DialogEstimate {
  const scoreText = scoringPrompt(officialCriteria, conversation);
  const scoreEst = estimateTokens(scoreText);

  const cases = makeJudgeCases(conversation, answers);
  const judgeText = judgePrompt(cases, conversation.messages);
  const judgeEst = estimateTokens(judgeText);

  const totalPassInputTokens = scoreEst.tokens + judgeEst.tokens;
  // Допущение: 1500 токенов на ответ основной оценки + 800 на AI Judge
  const passOutputTokens = 1500 + 800; // 2300 токенов

  // Минимум (2 вызова: 1 оценка + 1 судья)
  const minCostUsd = calculateCostUsd(totalPassInputTokens, passOutputTokens);

  // Максимум (6 вызовов: повтор при ошибке/обрезка + точечный повтор + 2 судьи + повтор)
  // ~3 вызова оценки + ~3 вызова судьи
  const maxInputTokens = scoreEst.tokens * 3 + judgeEst.tokens * 3;
  const maxOutputTokens = 1500 * 3 + 800 * 3; // 6900 токенов
  const maxCostUsd = calculateCostUsd(maxInputTokens, maxOutputTokens);

  return {
    id: conversation.externalId,
    group,
    lang: conversation.language,
    msgCount: conversation.messages.length,
    scorePromptChars: scoreEst.chars,
    scoreInputTokens: scoreEst.tokens,
    judgePromptChars: judgeEst.chars,
    judgeInputTokens: judgeEst.tokens,
    totalPassInputTokens,
    passOutputTokens,
    minCostUsd,
    maxCostUsd,
  };
}

export function runEstimation(): void {
  const demoList = buildDemo();
  const studyList = controlCases();

  const demoEstimates: DialogEstimate[] = demoList.map((conv) => analyzeDialog(conv, "demo"));
  const studyEstimates: DialogEstimate[] = studyList.map((item) =>
    analyzeDialog(item.conversation, "study", item.answers as Record<string, string | number>),
  );
  const allEstimates = [...demoEstimates, ...studyEstimates];

  console.log("==========================================================================================");
  console.log("             РАСЧЁТ СТОИМОСТИ ВЫЗОВОВ LLM (ОЦЕНКА БЕЗ РЕАЛЬНОГО ПРОГОНА)                  ");
  console.log("==========================================================================================");
  console.log("");
  console.log("МЕТОДИКА И ДОПУЩЕНИЯ:");
  console.log("1. Приближение токенизации: символы / 3 для кириллицы, символы / 4 для латиницы/пробелов.");
  console.log("2. Допущение по выходным токенам: 1500 на ответ оценки, 800 на ответ судьи (всего 2300 за проход).");
  console.log(`3. Тарифы модели (из types.ts): $${INPUT_USD_PER_M.toFixed(2)} за 1M входных, $${OUTPUT_USD_PER_M.toFixed(2)} за 1M выходных.`);
  console.log("   (Для локальной модели через Ollama/LM Studio стоимость $0.00).");
  console.log("4. Минимум: 2 вызова (1 оценка + 1 AI Judge).");
  console.log("5. Максимум: 6 вызовов (2 оценки при ошибке/обрезке + 1 точечный повтор + 2 вызова судьи + 1 повтор).");
  console.log("");

  console.log("------------------------------------------------------------------------------------------");
  console.log("ID диалога   | Группа | Язык | Реплик | Промпт оценки | Промпт судьи | Вход (проход) | Мин ($)  | Макс ($)");
  console.log("------------------------------------------------------------------------------------------");

  for (const est of allEstimates) {
    const id = est.id.padEnd(12);
    const grp = est.group.padEnd(6);
    const lang = est.lang.padEnd(4);
    const msgs = String(est.msgCount).padStart(6);
    const sc = `${est.scoreInputTokens} ток (${est.scorePromptChars} сим)`.padEnd(14);
    const jd = `${est.judgeInputTokens} ток (${est.judgePromptChars} сим)`.padEnd(13);
    const inp = `${est.totalPassInputTokens} токенов`.padStart(13);
    const minC = `$${est.minCostUsd.toFixed(4)}`.padStart(8);
    const maxC = `$${est.maxCostUsd.toFixed(4)}`.padStart(8);

    console.log(`${id} | ${grp} | ${lang} | ${msgs} | ${sc} | ${jd} | ${inp} | ${minC} | ${maxC}`);
  }

  console.log("------------------------------------------------------------------------------------------");

  function calcAverage(list: DialogEstimate[]) {
    const n = list.length;
    return {
      avgScoreTokens: Math.round(list.reduce((sum, e) => sum + e.scoreInputTokens, 0) / n),
      avgJudgeTokens: Math.round(list.reduce((sum, e) => sum + e.judgeInputTokens, 0) / n),
      avgInputTokens: Math.round(list.reduce((sum, e) => sum + e.totalPassInputTokens, 0) / n),
      avgMinCost: list.reduce((sum, e) => sum + e.minCostUsd, 0) / n,
      avgMaxCost: list.reduce((sum, e) => sum + e.maxCostUsd, 0) / n,
    };
  }

  const avgDemo = calcAverage(demoEstimates);
  const avgStudy = calcAverage(studyEstimates);
  const avgAll = calcAverage(allEstimates);

  console.log("");
  console.log("СРЕДНИЕ ЗНАЧЕНИЯ ПО ГРУППАМ:");
  console.log(`• Демо-диалоги (${demoEstimates.length} шт):`);
  console.log(`  - Входные токены за проход: ${avgDemo.avgInputTokens} (оценка: ${avgDemo.avgScoreTokens}, судья: ${avgDemo.avgJudgeTokens})`);
  console.log(`  - Выходные токены (допущение): 2300 (оценка 1500 + судья 800)`);
  console.log(`  - Стоимость диалога: от $${avgDemo.avgMinCost.toFixed(4)} (мин, 2 вызова) до $${avgDemo.avgMaxCost.toFixed(4)} (макс, 6 вызовов)`);
  console.log("");
  console.log(`• Учебные диалоги (${studyEstimates.length} шт):`);
  console.log(`  - Входные токены за проход: ${avgStudy.avgInputTokens} (оценка: ${avgStudy.avgScoreTokens}, судья: ${avgStudy.avgJudgeTokens})`);
  console.log(`  - Выходные токены (допущение): 2300 (оценка 1500 + судья 800)`);
  console.log(`  - Стоимость диалога: от $${avgStudy.avgMinCost.toFixed(4)} (мин, 2 вызова) до $${avgStudy.avgMaxCost.toFixed(4)} (макс, 6 вызовов)`);
  console.log("");
  console.log(`• В СРЕДНЕМ ПО ВСЕМ ДИАЛОГАМ (${allEstimates.length} шт):`);
  console.log(`  - Входные токены одного прохода: ${avgAll.avgInputTokens}`);
  console.log(`  - Ожидаемые выходные токены (допущение): 2300`);
  console.log(`  - Стоимость 1 диалога:`);
  console.log(`      * Минимум (2 вызова: оценка + судья):       $${avgAll.avgMinCost.toFixed(4)}`);
  console.log(`      * Максимум (6 вызовов: повторы и re-judge): $${avgAll.avgMaxCost.toFixed(4)}`);
  console.log("");
  console.log(`• ПРОГНОЗ ДЛЯ ПАКЕТА ИЗ 10 НОВЫХ ДИАЛОГОВ (хакатон):`);
  console.log(`  - Минимальная стоимость (без сбоев и споров):    $${(avgAll.avgMinCost * 10).toFixed(3)}`);
  console.log(`  - Максимальная стоимость (при всех повторах):     $${(avgAll.avgMaxCost * 10).toFixed(3)}`);
  console.log("==========================================================================================");
}

runEstimation();
