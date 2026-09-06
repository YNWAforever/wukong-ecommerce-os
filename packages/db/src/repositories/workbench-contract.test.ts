import { describe, expect, it } from "vitest";

import { classifyListing } from "./workbench-contract.js";

describe("classifyListing", () => {
  it.each([
    ["failed", "failed"],
    ["publish_failed", "failed"],
    ["needs_info", "needs_info"],
    ["in_review", "review"],
    ["reopened", "review"],
    ["approved", "delivery"],
    ["received", "processing"],
    ["processing", "processing"],
    ["publishing", "processing"],
    ["published", "published"],
    ["future_status", "unknown"],
  ] as const)("maps %s to the semantic reason %s", (status, reason) => {
    expect(classifyListing(status)).toBe(reason);
  });

  it("keeps approved work actionable and unknown states visible", () => {
    expect(classifyListing("approved")).toBe("delivery");
    expect(classifyListing("reopened")).toBe("review");
    expect(classifyListing("future_status")).toBe("unknown");
  });
});
