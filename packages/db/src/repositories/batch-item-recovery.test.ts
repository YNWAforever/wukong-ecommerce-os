import { expect, it } from "vitest";
import { batchItemRecovery } from "./batch-item-recovery.js";
it("never retries unknown, human-input/review, cancelled, unclassified or prior attempts", () => {
  const base = {
    outcome: "failed",
    errorCode: "provider_timeout",
    costUnknown: false,
    isCurrent: true,
  };
  expect(batchItemRecovery(base)).toEqual({
    recovery: "retryable",
    canRetry: true,
  });
  expect(batchItemRecovery({ ...base, costUnknown: true })).toEqual({
    recovery: "outcome-unknown",
    canRetry: false,
  });
  expect(batchItemRecovery({ ...base, outcome: "needs_input" })).toEqual({
    recovery: "needs-input",
    canRetry: false,
  });
  expect(batchItemRecovery({ ...base, outcome: "superseded" })).toEqual({
    recovery: "needs-review",
    canRetry: false,
  });
  for (const input of [
    { ...base, outcome: "cancelled" },
    { ...base, errorCode: "unclassified" },
    { ...base, isCurrent: false },
  ])
    expect(batchItemRecovery(input).canRetry).toBe(false);
});
