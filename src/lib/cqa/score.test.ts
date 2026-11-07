import assert from "node:assert/strict";
import test from "node:test";
import { officialCriteria } from "./seed.ts";
import { computeScore, roundHalfUp } from "./score.ts";
import type { Answer } from "./types.ts";

test("half up", () => {
  assert.equal(roundHalfUp(81.875, 2), 81.88);
  assert.equal(roundHalfUp(65.5, 2), 65.5);
  assert.equal(roundHalfUp(1.005, 2), 1.01);
  assert.equal(roundHalfUp(1.004, 2), 1);
});

test("example A stays 65.50 even if C08 is yes", () => {
  const answers = {
    C01: "yes",
    C02: "yes",
    C03: "no",
    C04: 15,
    C05: "yes",
    C06: 7,
    C07: "no",
    C08: "yes",
  } as const;
  const scored = computeScore(officialCriteria, answers);
  assert.equal(scored.status, "ok");
  assert.equal(scored.total, 65.5);
  assert.equal(scored.critical, true);
  const clean = computeScore(officialCriteria, { ...answers, C08: "no" });
  assert.equal(clean.total, scored.total);
});

test("example B redistributes C03 N/A to 81.88", () => {
  const scored = computeScore(officialCriteria, {
    C01: "yes",
    C02: "yes",
    C03: "na",
    C04: 15,
    C05: "yes",
    C06: 7,
    C07: "no",
    C08: "no",
  });
  assert.equal(scored.total, 81.88);
  assert.equal(scored.denominator, 80);
});

test("rejects illegal steps and N/A on C01", () => {
  const illegal = computeScore(officialCriteria, {
    C01: "yes",
    C02: "yes",
    C03: "no",
    C04: 13,
    C05: "yes",
    C06: 7,
    C07: "no",
    C08: "no",
  });
  assert.equal(illegal.status, "invalid");
  const na = computeScore(officialCriteria, {
    C01: "na",
    C02: "yes",
    C03: "no",
    C04: 15,
    C05: "yes",
    C06: 7,
    C07: "no",
    C08: "no",
  });
  assert.equal(na.status, "invalid");
});

test("N/A is rejected for C05, C06 and C08", () => {
  for (const id of ["C05", "C06", "C08"] as const) {
    const scored = computeScore(officialCriteria, {
      C01: "yes",
      C02: "yes",
      C03: "no",
      C04: 15,
      C05: "yes",
      C06: 7,
      C07: "no",
      C08: "no",
      [id]: "na",
    });
    assert.equal(scored.status, "invalid");
  }
});
test("all weighted N/A is not scorable", () => {
  const criteria = officialCriteria.map((item) =>
    item.answerType === "flag"
      ? item
      : { ...item, answerType: "yes_no_na" as const, naAllowed: true, scale: undefined },
  );
  const answers: Record<string, Answer> = Object.fromEntries(
    criteria.map((item) => [item.id, item.answerType === "flag" ? "no" : "na"]),
  );
  const scored = computeScore(criteria, answers);
  assert.equal(scored.status, "not_scorable");
  assert.equal(scored.total, null);
});
