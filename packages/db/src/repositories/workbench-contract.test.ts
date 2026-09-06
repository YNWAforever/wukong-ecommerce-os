import { describe, expect, it } from "vitest";

import {
  classifyListing,
  workbenchStateForReason,
} from "./workbench-contract.js";

describe("classifyListing", () => {
  it.each([
    ["failed", "failed", "attention"],
    ["publish_failed", "failed", "attention"],
    ["needs_info", "needs_info", "attention"],
    ["in_review", "review", "attention"],
    ["reopened", "review", "attention"],
    ["approved", "delivery", "attention"],
    ["received", "processing", "progress"],
    ["processing", "processing", "progress"],
    ["publishing", "processing", "progress"],
    ["published", "published", "completed"],
    ["future_status", "unknown", "unclassified"],
  ] as const)("maps %s to its reason and state", (status, reason, state) => {
    expect(classifyListing(status)).toBe(reason);
    expect(workbenchStateForReason(reason)).toBe(state);
  });

  it.each([
    ["failed", "attention"],
    ["needs_info", "attention"],
    ["review", "attention"],
    ["delivery", "attention"],
    ["result_needed", "attention"],
    ["processing", "progress"],
    ["published", "completed"],
    ["result_reported", "completed"],
    ["preview_ready", "completed"],
    ["preview_partial", "completed"],
    ["imported", "completed"],
    ["unknown", "unclassified"],
  ] as const)(
    "maps every reason %s to exactly one state %s",
    (reason, state) => {
      expect(workbenchStateForReason(reason)).toBe(state);
    },
  );
});
