import { describe, expect, it } from "vitest";
import { transitionListing } from "./workflow";

describe("transitionListing", () => {
  it.each([
    ["received", "start_processing", "processing"],
    ["processing", "request_info", "needs_info"],
    ["processing", "submit_review", "in_review"],
    ["processing", "fail", "failed"],
    ["needs_info", "start_processing", "processing"],
    ["in_review", "approve", "approved"],
    ["approved", "reopen", "reopened"],
    ["approved", "begin_publish", "publishing"],
    ["reopened", "submit_review", "in_review"],
    ["publishing", "publish_succeeded", "published"],
    ["publishing", "publish_failed", "publish_failed"],
    ["published", "reopen", "reopened"],
    ["publish_failed", "retry", "publishing"],
    ["publish_failed", "reopen", "reopened"],
    ["failed", "retry", "processing"]
  ] as const)("permits %s -> %s -> %s", (status, action, expected) => {
    expect(transitionListing(status, action)).toBe(expected);
  });

  it("rejects delivery from an unapproved state", () => {
    expect(() => transitionListing("in_review", "begin_publish")).toThrow(
      "Illegal transition: in_review -> begin_publish"
    );
  });

  it("rejects approval before review", () => {
    expect(() => transitionListing("processing", "approve")).toThrow(
      "Illegal transition: processing -> approve"
    );
  });
});
