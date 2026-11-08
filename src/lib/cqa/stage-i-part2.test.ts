import test from "node:test";
import assert from "node:assert/strict";
import {
  createSafeStorage,
  getDatasetGroupStats,
  useCqa,
} from "./store.ts";
import type {
  Appeal,
  Conversation,
  CriterionResult,
  Evaluation,
  ReviewDecision,
} from "./types.ts";

function createMockConversation(id: string, datasetGroupId: string, externalId: string): Conversation {
  return {
    id,
    datasetGroupId,
    externalId,
    channel: "agent chat",
    language: "RU",
    audioUrl: null,
    messages: [
      { messageIndex: 0, speaker: "client", text: "Здравствуйте", timestampRaw: "10:00" },
      { messageIndex: 1, speaker: "operator", text: "Добрый день! Чем могу помочь?", timestampRaw: "10:01" },
    ],
    origin: "upload",
  };
}

function createMockEvaluation(id: string, conversationId: string): Evaluation {
  const dummyResult: CriterionResult = {
    criterionId: "C01",
    answer: "yes",
    reason: "Приветствие оператора присутствует",
    evidence: [{ messageIndex: 1, quote: "Добрый день! Чем могу помочь?" }],
    checkedRange: null,
    naReason: null,
    validationStatus: "ok",
    weight: 10,
    normalized: 10,
    contribution: 10,
    isNa: false,
    critical: false,
  };
  const now = new Date().toISOString();
  return {
    id,
    conversationId,
    checklistVersionId: "v1-official",
    configHash: "test-hash",
    model: "grok-4.7",
    promptVersion: "cqa-s5-v5",
    startedAt: now,
    source: "heuristic",
    status: "completed",
    baseResults: [dummyResult],
    finalResults: [dummyResult],
    baseTotal: 100,
    finalTotal: 100,
    baseRaw: 100,
    finalRaw: 100,
    baseCritical: false,
    finalCritical: false,
    usage: null,
    trace: [],
    createdAt: now,
  };
}

function createMockAppeal(id: string, evaluationId: string, criterionId: string): Appeal {
  return {
    id,
    evaluationId,
    criterionId,
    comment: "Прошу пересмотреть оценку C01",
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };
}

function createMockDecision(id: string, appealId: string): ReviewDecision {
  return {
    id,
    appealId,
    action: "confirmed",
    oldAnswer: "yes",
    newAnswer: "yes",
    reason: "Оценка подтверждена старшим контролёром",
    createdAt: new Date().toISOString(),
  };
}

test("Stage I.2: createSafeStorage catches synchronous QuotaExceededError and sets storageError: true", () => {
  let shouldThrow = true;
  const mockStorage: Storage = {
    getItem: () => null,
    setItem: () => {
      if (shouldThrow) {
        const err = new Error("QuotaExceededError: The quota has been exceeded.");
        err.name = "QuotaExceededError";
        throw err;
      }
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };

  useCqa.persist.setOptions({
    storage: createSafeStorage(() => mockStorage),
  });

  useCqa.getState().clearStorageError();
  assert.equal(useCqa.getState().storageError, false);

  // Trigger state mutation that tries to persist
  assert.doesNotThrow(() => {
    useCqa.getState().setRole("editor");
  });

  // Verify storageError flag is set to true without crashing the store
  assert.equal(useCqa.getState().storageError, true);
  assert.equal(useCqa.getState().role, "editor");

  // Verify clearStorageError resets flag to false
  useCqa.getState().clearStorageError();
  assert.equal(useCqa.getState().storageError, false);

  // When storage write succeeds, flag automatically stays or transitions to false
  shouldThrow = false;
  assert.doesNotThrow(() => {
    useCqa.getState().setRole("analyst");
  });
  assert.equal(useCqa.getState().storageError, false);
  assert.equal(useCqa.getState().role, "analyst");
});

test("Stage I.2: createSafeStorage handles async Promise rejection in setItem", async () => {
  let rejectPromise = true;
  const asyncStorage = {
    getItem: () => Promise.resolve(null),
    setItem: () => {
      if (rejectPromise) {
        return Promise.reject(new Error("Async QuotaExceededError"));
      }
      return Promise.resolve();
    },
    removeItem: () => Promise.resolve(),
  };

  useCqa.persist.setOptions({
    storage: createSafeStorage(() => asyncStorage as unknown as Storage),
  });

  useCqa.getState().clearStorageError();
  assert.equal(useCqa.getState().storageError, false);

  useCqa.getState().setRole("reviewer");
  // Give promise tick to settle
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(useCqa.getState().storageError, true);

  rejectPromise = false;
  useCqa.getState().setRole("analyst");
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(useCqa.getState().storageError, false);
});

test("Stage I.2: createSafeStorage standalone with custom callbacks and resilience against corrupt reads", () => {
  let errorCaught: unknown = null;
  let successCount = 0;

  const faultyStorage = {
    getItem: () => {
      throw new Error("Disk corruption read error");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("Permission error");
    },
  };

  const safe = createSafeStorage(() => faultyStorage as unknown as Storage, {
    onError: (err) => {
      errorCaught = err;
    },
    onSuccess: () => {
      successCount++;
    },
  });

  // getItem should not throw on disk errors, returns null
  assert.doesNotThrow(() => {
    const val = safe.getItem("test-key");
    assert.equal(val, null);
  });

  // removeItem should not throw
  assert.doesNotThrow(() => {
    safe.removeItem("test-key");
  });

  // setItem catches error and invokes onError callback without throwing
  assert.doesNotThrow(() => {
    safe.setItem("test-key", { state: { role: "analyst" } });
  });
  assert.ok(errorCaught instanceof Error);
  assert.equal((errorCaught as Error).message, "QuotaExceededError");
  assert.equal(successCount, 0);
});

test("Stage I.2: getDatasetGroupStats and deleteDatasetGroup cascade deletion", () => {
  // Reset store to known state
  useCqa.getState().resetLocal();

  const convA1 = createMockConversation("conv-a1", "ALPHA", "EXT-A1");
  const convA2 = createMockConversation("conv-a2", "ALPHA", "EXT-A2");
  const convB1 = createMockConversation("conv-b1", "BETA", "EXT-B1");

  const evalA1 = createMockEvaluation("eval-a1", "conv-a1");
  const evalA2 = createMockEvaluation("eval-a2", "conv-a2");
  const evalB1 = createMockEvaluation("eval-b1", "conv-b1");

  const appealA1 = createMockAppeal("appeal-a1", "eval-a1", "C01");
  const appealB1 = createMockAppeal("appeal-b1", "eval-b1", "C01");

  const decisionA1 = createMockDecision("dec-a1", "appeal-a1");
  const decisionB1 = createMockDecision("dec-b1", "appeal-b1");

  useCqa.setState((prev) => ({
    conversations: [...prev.conversations, convA1, convA2, convB1],
    evaluations: [...prev.evaluations, evalA1, evalA2, evalB1],
    appeals: [...prev.appeals, appealA1, appealB1],
    decisions: [...prev.decisions, decisionA1, decisionB1],
    jobs: [
      {
        id: "job-1",
        mode: "heuristic",
        status: "completed",
        total: 3,
        completed: 3,
        failed: 0,
        needsReview: 0,
        errors: [{ conversationId: "conv-a1", message: "Transient error" }],
        items: [
          { conversationId: "conv-a1", status: "completed", attempts: 1 },
          { conversationId: "conv-a2", status: "completed", attempts: 1 },
          { conversationId: "conv-b1", status: "completed", attempts: 1 },
        ],
        createdAt: new Date().toISOString(),
      },
    ],
  }));

  const stateBefore = useCqa.getState();

  // Test getDatasetGroupStats
  const statsAlpha = getDatasetGroupStats(stateBefore, "ALPHA");
  assert.equal(statsAlpha.conversations, 2);
  assert.equal(statsAlpha.evaluations, 2);
  assert.equal(statsAlpha.appeals, 1);
  assert.equal(statsAlpha.decisions, 1);

  const statsBeta = getDatasetGroupStats(stateBefore, "BETA");
  assert.equal(statsBeta.conversations, 1);
  assert.equal(statsBeta.evaluations, 1);
  assert.equal(statsBeta.appeals, 1);
  assert.equal(statsBeta.decisions, 1);

  // Perform cascade deletion of ALPHA
  const deleteResult = useCqa.getState().deleteDatasetGroup("ALPHA");
  assert.deepEqual(deleteResult, {
    conversations: 2,
    evaluations: 2,
    appeals: 1,
    decisions: 1,
  });

  const stateAfter = useCqa.getState();

  // Verify ALPHA is completely deleted
  assert.equal(stateAfter.conversations.some((c) => c.datasetGroupId === "ALPHA"), false);
  assert.equal(stateAfter.evaluations.some((e) => e.conversationId === "conv-a1" || e.conversationId === "conv-a2"), false);
  assert.equal(stateAfter.appeals.some((a) => a.id === "appeal-a1" || a.evaluationId === "eval-a1" || a.evaluationId === "eval-a2"), false);
  assert.equal(stateAfter.decisions.some((d) => d.id === "dec-a1" || d.appealId === "appeal-a1"), false);

  // Verify job items and errors for ALPHA were pruned
  const jobAfter = stateAfter.jobs.find((j) => j.id === "job-1");
  assert.ok(jobAfter);
  assert.equal(jobAfter.items.some((i) => i.conversationId.startsWith("conv-a")), false);
  assert.equal(jobAfter.errors.some((e) => e.conversationId.startsWith("conv-a")), false);

  // Verify BETA is 100% intact
  assert.equal(stateAfter.conversations.some((c) => c.id === "conv-b1" && c.datasetGroupId === "BETA"), true);
  assert.equal(stateAfter.evaluations.some((e) => e.id === "eval-b1" && e.conversationId === "conv-b1"), true);
  assert.equal(stateAfter.appeals.some((a) => a.id === "appeal-b1"), true);
  assert.equal(stateAfter.decisions.some((d) => d.id === "dec-b1"), true);
  assert.equal(jobAfter.items.some((i) => i.conversationId === "conv-b1"), true);

  // Verify demo conversations are also intact
  assert.equal(stateAfter.conversations.some((c) => c.datasetGroupId === "DEMO"), true);
});

test("Stage I.2: deleteDatasetGroup on non-existent group is a safe no-op", () => {
  const stateBefore = useCqa.getState();
  const convCountBefore = stateBefore.conversations.length;

  const result = useCqa.getState().deleteDatasetGroup("DOES_NOT_EXIST_GROUP");
  assert.deepEqual(result, {
    conversations: 0,
    evaluations: 0,
    appeals: 0,
    decisions: 0,
  });

  const stateAfter = useCqa.getState();
  assert.equal(stateAfter.conversations.length, convCountBefore);
});
