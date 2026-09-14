/**
 * A checklist nothing reads is a checklist nothing enforces.
 *
 * `production-readiness.md` is the entry condition for Opak UAT and consisted
 * of twenty unchecked boxes with no script behind any of them. The danger is
 * not that a box is unchecked -- most of them should be, until a person checks
 * them -- but that an unchecked box which source already settles is
 * indistinguishable from one that needs a deployment, a secret manager or a
 * merchant.
 *
 * These cases keep the split honest in both directions: a box with no check
 * fails, and a check with no box fails. Adding a line to the runbook therefore
 * forces a decision about which kind it is.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_GATE_CHECKS,
  readinessCheckboxes,
  runAutomatedChecks,
} from "../scripts/check-release-gate.mjs";

test("every readiness box is claimed by exactly one check", () => {
  const unclaimed = readinessCheckboxes().filter(
    (statement) =>
      !RELEASE_GATE_CHECKS.some((check) => statement.startsWith(check.key)),
  );

  assert.deepEqual(
    unclaimed,
    [],
    "these runbook boxes have no entry in RELEASE_GATE_CHECKS",
  );
});

test("every check still matches a line in the runbook", () => {
  // The other direction: a check whose box was reworded or deleted is worse
  // than no check, because it reports on something nobody is asking for.
  const statements = readinessCheckboxes();
  const orphaned = RELEASE_GATE_CHECKS.filter(
    (check) => !statements.some((statement) => statement.startsWith(check.key)),
  ).map((check) => check.key);

  assert.deepEqual(orphaned, [], "these checks match no runbook box");
});

test("each box is claimed once, not several times", () => {
  for (const statement of readinessCheckboxes()) {
    const matches = RELEASE_GATE_CHECKS.filter((check) =>
      statement.startsWith(check.key),
    );
    assert.equal(
      matches.length,
      1,
      `${matches.length} checks match: ${statement.slice(0, 60)}`,
    );
  }
});

test("the automated half passes", () => {
  const failed = runAutomatedChecks().filter((result) => !result.ok);

  assert.deepEqual(
    failed.map((result) => `${result.key}: ${result.detail}`),
    [],
  );
});

test("every human box says why a person is needed", () => {
  // Without a reason, "human" becomes a place to put anything inconvenient to
  // check. The reason is what makes the classification reviewable.
  for (const check of RELEASE_GATE_CHECKS) {
    if (check.kind !== "human") continue;
    assert.ok(
      typeof check.because === "string" && check.because.length > 20,
      `${check.key} is marked human with no reason`,
    );
  }
});

test("the split is recorded, not merely computed", () => {
  // A sanity floor: if the runbook were emptied or the parser broke, every
  // assertion above would pass vacuously.
  const statements = readinessCheckboxes();
  const automated = RELEASE_GATE_CHECKS.filter(
    (check) => check.kind === "automated",
  );

  assert.equal(statements.length, RELEASE_GATE_CHECKS.length);
  assert.ok(statements.length >= 20, `only ${statements.length} boxes parsed`);
  assert.ok(automated.length >= 6, `only ${automated.length} automated checks`);
});
