import test from "node:test";
import assert from "node:assert/strict";
import { controlCases } from "./control.ts";
import { officialCriteria } from "./seed.ts";
import { answerAllowed, computeScore } from "./score.ts";
import type { Answer } from "./types.ts";

test("Stage F: exactly 34 control cases with unique IDs", () => {
  const cases = controlCases();
  assert.equal(cases.length, 34);

  const ids = new Set<string>();
  const externalIds = new Set<string>();
  for (const c of cases) {
    assert.ok(!ids.has(c.conversation.id), `Duplicate conversation.id: ${c.conversation.id}`);
    assert.ok(!externalIds.has(c.conversation.externalId), `Duplicate externalId: ${c.conversation.externalId}`);
    ids.add(c.conversation.id);
    externalIds.add(c.conversation.externalId);
  }
});

test("Stage F: all ground truth answers are allowed by official criteria", () => {
  const cases = controlCases();
  const criteriaMap = new Map(officialCriteria.map((c) => [c.id, c]));

  for (const c of cases) {
    for (const [critId, answer] of Object.entries(c.answers)) {
      const crit = criteriaMap.get(critId);
      assert.ok(crit, `Criterion ${critId} exists in official checklist`);
      assert.ok(
        answerAllowed(crit, answer),
        `Answer ${answer} is not allowed for criterion ${critId} in case ${c.conversation.externalId}`,
      );
    }
  }
});

test("Stage F: N/A is only present on C02, C03, C04, C07", () => {
  const cases = controlCases();
  const naAllowedCriteria = new Set(["C02", "C03", "C04", "C07"]);

  for (const c of cases) {
    for (const [critId, answer] of Object.entries(c.answers)) {
      if (answer === "na") {
        assert.ok(
          naAllowedCriteria.has(critId),
          `Criterion ${critId} cannot have N/A in case ${c.conversation.externalId}`,
        );
      }
    }
  }
});

test("Stage F: all scale steps occur at least once across the set for each criterion", () => {
  const cases = controlCases();

  const expectedSteps: Record<string, Answer[]> = {
    C01: ["yes", "no"],
    C02: ["yes", "no", "na"],
    C03: ["yes", "no", "na"],
    C04: [0, 5, 10, 15, 20, "na"],
    C05: ["yes", "no"],
    C06: [0, 4, 7, 10],
    C07: ["yes", "no", "na"],
    C08: ["yes", "no"],
  };

  for (const [critId, steps] of Object.entries(expectedSteps)) {
    const presentSteps = new Set<Answer>();
    for (const c of cases) {
      if (critId in c.answers) {
        presentSteps.add(c.answers[critId]);
      }
    }
    for (const step of steps) {
      assert.ok(
        presentSteps.has(step),
        `Criterion ${critId} is missing step ${step} in control cases (found: ${[...presentSteps].join(", ")})`,
      );
    }
  }
});

test("Stage F: computeScore produces a numeric score for each control case", () => {
  const cases = controlCases();
  for (const c of cases) {
    const outcome = computeScore(officialCriteria, c.answers);
    assert.ok(outcome.total !== null, `total should not be null for case ${c.conversation.externalId}`);
    assert.equal(typeof outcome.total, "number", `total should be a number for case ${c.conversation.externalId}`);
    assert.ok(
      Number.isFinite(outcome.total),
      `total should be finite for case ${c.conversation.externalId}, got ${outcome.total}`,
    );
    assert.ok(
      outcome.total !== null && outcome.total >= 0 && outcome.total <= 100,
      `total should be between 0 and 100 for case ${c.conversation.externalId}, got ${outcome.total}`,
    );
  }
});

test("Stage F: message count between 4 and 10 for all 24 new cases", () => {
  const cases = controlCases();
  const newCases = cases.filter((c) => {
    const id = c.conversation.externalId;
    return id !== "c-en-10" && (id.startsWith("c-ru-1") || id.startsWith("c-kz-1") || id.startsWith("c-en-1"));
  });
  assert.equal(newCases.length, 24);
  for (const c of newCases) {
    const count = c.conversation.messages.length;
    assert.ok(
      count >= 4 && count <= 10,
      `Message count for ${c.conversation.externalId} must be 4..10, got ${count}`,
    );
  }
});
