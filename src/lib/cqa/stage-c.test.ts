import assert from "node:assert/strict";
import test from "node:test";
import { mapCancelledItem, resolveCancelledStatus, runQueue } from "./queue.ts";
import { selectBatchTargets } from "./store.ts";
import type { Evaluation } from "./types.ts";

test("1. сопоставление статусов при отмене: mapCancelledItem и resolveCancelledStatus", () => {
  // незапущенные из-за отмены → pending
  assert.deepEqual(resolveCancelledStatus("pending"), { status: "pending", message: undefined });
  assert.deepEqual(resolveCancelledStatus("cancelled"), { status: "pending", message: undefined });

  // элемент в работе в момент отмены → failed с сообщением «отменено»
  assert.deepEqual(resolveCancelledStatus("running"), { status: "failed", message: "отменено" });
  assert.deepEqual(resolveCancelledStatus("running", "произвольное"), { status: "failed", message: "отменено" });

  // уже завершённые сохраняют статус и сообщение
  assert.deepEqual(resolveCancelledStatus("completed"), { status: "completed", message: undefined });
  assert.deepEqual(resolveCancelledStatus("needs_review"), { status: "needs_review", message: undefined });
  assert.deepEqual(resolveCancelledStatus("failed", "сеть"), { status: "failed", message: "сеть" });

  const mappedRunning = mapCancelledItem({ id: "x", status: "running", attempts: 1 });
  assert.equal(mappedRunning.status, "failed");
  assert.equal(mappedRunning.message, "отменено");

  const mappedPending = mapCancelledItem({ id: "y", status: "pending", attempts: 0 });
  assert.equal(mappedPending.status, "pending");
  assert.equal(mappedPending.message, undefined);
});

test("2. отмена нажата во время выполнения элемента, work затем вернул completed → элемент completed, не failed; незапущенные pending", async () => {
  let cancelled = false;
  let runningIndex = -1;

  const outcome = await runQueue({
    items: Array.from({ length: 6 }, (_, index) => ({ id: `conv-${index}`, payload: index })),
    concurrency: 1,
    maxAttempts: 1,
    retryDelayMs: 0,
    isCancelled: () => cancelled,
    work: async (index) => {
      runningIndex = index;
      if (index === 1) {
        // отменяем во время обработки второго элемента (индекс 1)
        cancelled = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      // work затем вернул completed
      return "completed";
    },
  });

  assert.equal(outcome.status, "cancelled");
  assert.equal(runningIndex, 1);

  // Элемент 0 успел завершиться
  assert.equal(outcome.items[0]?.status, "completed");

  // Элемент 1: отмена нажата во время выполнения, work затем вернул completed → completed, не failed
  assert.equal(outcome.items[1]?.status, "completed");

  // Элементы 2..5 не были запущены из-за отмены → pending
  for (let i = 2; i < 6; i++) {
    assert.equal(outcome.items[i]?.status, "pending", `Элемент ${i} должен остаться pending`);
    assert.equal(outcome.items[i]?.attempts, 0);
  }
});

test("2b. отмена во время выполнения элемента без возврата результата (прерывание) → failed с 'отменено'", async () => {
  let cancelled = false;

  const outcome = await runQueue({
    items: [{ id: "c-0", payload: 0 }, { id: "c-1", payload: 1 }],
    concurrency: 1,
    maxAttempts: 1,
    retryDelayMs: 0,
    isCancelled: () => cancelled,
    work: async (index) => {
      if (index === 0) {
        cancelled = true;
        throw new Error("аборт соединения");
      }
      return "completed";
    },
  });

  assert.equal(outcome.items[0]?.status, "failed");
  assert.equal(outcome.items[0]?.message, "отменено");
  assert.equal(outcome.items[1]?.status, "pending");
});

test("3. лимит 1$ при оценке 0.4$ на диалог → параллельно стартует не больше 2, stoppedByBudget = true, остальные pending", async () => {
  let activeConcurrent = 0;
  let maxConcurrent = 0;

  const outcome = await runQueue({
    items: Array.from({ length: 5 }, (_, index) => ({ id: `item-${index}`, payload: index })),
    concurrency: 4,
    maxAttempts: 1,
    retryDelayMs: 0,
    costCap: 1.0,
    estimateCostUsd: 0.4,
    work: async () => {
      activeConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, activeConcurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      activeConcurrent--;
      return { status: "completed", costUsd: 0.4 };
    },
  });

  // При лимите 1.0$ и оценке 0.4$ параллельно стартует ровно 2 (0.4 + 0.4 = 0.8, третий потребовал бы 1.2 > 1.0)
  assert.ok(maxConcurrent <= 2, `Параллельно должно стартовать не больше 2, факт: ${maxConcurrent}`);
  assert.equal(maxConcurrent, 2, "Должно запуститься 2 параллельных задачи");
  assert.equal(outcome.stoppedByBudget, true, "stoppedByBudget должно быть true");
  assert.equal(outcome.completed, 2, "Должно быть обработано 2 элемента");

  // Завершились первые 2, остальные 3 не запустились из-за исчерпания лимита → pending
  assert.equal(outcome.items[0]?.status, "completed");
  assert.equal(outcome.items[1]?.status, "completed");
  assert.equal(outcome.items[2]?.status, "pending");
  assert.equal(outcome.items[3]?.status, "pending");
  assert.equal(outcome.items[4]?.status, "pending");
});

test("4. пакеты из 65 и из 10 элементов обрабатываются полностью без лимита", async () => {
  // Пакет из 65 элементов
  let calls65 = 0;
  const outcome65 = await runQueue({
    items: Array.from({ length: 65 }, (_, index) => ({ id: `elem-65-${index}`, payload: index })),
    concurrency: 4,
    maxAttempts: 1,
    retryDelayMs: 0,
    work: async () => {
      calls65++;
      return "completed";
    },
  });

  assert.equal(outcome65.status, "completed");
  assert.equal(outcome65.completed, 65);
  assert.equal(calls65, 65);
  assert.equal(outcome65.items.filter((item) => item.status === "completed").length, 65);

  // Пакет из 10 элементов
  let calls10 = 0;
  const outcome10 = await runQueue({
    items: Array.from({ length: 10 }, (_, index) => ({ id: `elem-10-${index}`, payload: index })),
    concurrency: 2,
    maxAttempts: 1,
    retryDelayMs: 0,
    work: async () => {
      calls10++;
      return "completed";
    },
  });

  assert.equal(outcome10.status, "completed");
  assert.equal(outcome10.completed, 10);
  assert.equal(calls10, 10);
  assert.equal(outcome10.items.filter((item) => item.status === "completed").length, 10);
});

test("5. замена резерва фактом и учёт usage при ошибке {ok:false, error, usage?}", async () => {
  // Если первый элемент вернул фактическую стоимость меньше резерва (0.1$ вместо 0.4$),
  // освободившийся резерв позволяет запуститься следующему элементу
  const outcome = await runQueue({
    items: [
      { id: "cheap-1", payload: "cheap" },
      { id: "cheap-2", payload: "cheap" },
      { id: "item-3", payload: "next" },
    ],
    concurrency: 2,
    maxAttempts: 1,
    retryDelayMs: 0,
    costCap: 1.0,
    estimateCostUsd: 0.4,
    work: async (payload) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (payload === "cheap") {
        return { status: "completed", costUsd: 0.1 };
      }
      return { status: "completed", costUsd: 0.2 };
    },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.completed, 3);
  assert.equal(outcome.spent, 0.4);

  // Ошибка с полем costUsd (из usage) учитывается в расходах
  const errorWithCostOutcome = await runQueue({
    items: [{ id: "failed-with-cost", payload: 1 }],
    concurrency: 1,
    maxAttempts: 1,
    retryDelayMs: 0,
    costCap: 1.0,
    estimateCostUsd: 0.4,
    work: async () => {
      const err = new Error("xAI ответил 429") as Error & { costUsd?: number };
      err.costUsd = 0.15;
      throw err;
    },
  });

  assert.equal(errorWithCostOutcome.status, "failed");
  assert.equal(errorWithCostOutcome.failed, 1);
  assert.equal(errorWithCostOutcome.spent, 0.15);
});

test("6. оценка со статусом needs_review — успешный результат, сохраняется и повторно не запускается", () => {
  // В selectBatchTargets:
  // Диалог с оценкой needs_review не выбирается для запуска (он уже оценён)
  const existingEval: Evaluation = {
    id: "eval-review-1",
    conversationId: "conv-needs-review",
    checklistVersionId: "official-chat-v1",
    configHash: "hash1",
    source: "ai",
    status: "needs_review",
    baseTotal: 80,
    finalTotal: 80,
    baseRaw: 80,
    finalRaw: 80,
    baseCritical: false,
    finalCritical: false,
    startedAt: "2026-03-01T10:00:00Z",
    baseResults: [],
    finalResults: [],
    model: "grok-beta",
    promptVersion: "cqa-v1",
    usage: { promptTokens: 100, completionTokens: 100, estimatedCostUsd: 0.002, calls: 2 },
    trace: [],
    createdAt: "2026-03-01T10:00:00Z",
  };

  const selectedNormal = selectBatchTargets({
    conversationIds: ["conv-needs-review", "conv-new"],
    evaluations: [existingEval],
    versionId: "official-chat-v1",
    configHash: "hash1",
    mode: "ai",
    modelId: "grok-beta",
    promptVersion: "cqa-v1",
    onlyFailed: false,
  });

  assert.deepEqual(selectedNormal, ["conv-new"], "needs_review не должен выбираться как неоценённый");

  const selectedOnlyFailed = selectBatchTargets({
    conversationIds: ["conv-needs-review", "conv-new"],
    evaluations: [existingEval],
    versionId: "official-chat-v1",
    configHash: "hash1",
    mode: "ai",
    modelId: "grok-beta",
    promptVersion: "cqa-v1",
    onlyFailed: true,
  });

  assert.deepEqual(selectedOnlyFailed, [], "needs_review не должен выбираться в 'повторить неудачные'");
});
