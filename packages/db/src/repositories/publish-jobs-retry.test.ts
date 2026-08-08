import { describe, expect, it } from "vitest";

import {
  isRetryablePublishJobError,
  sanitizePublishJobErrorCode,
} from "./publish-jobs.js";

describe("publish job retry classification", () => {
  it.each(["remote_unavailable", "rate_limited"])(
    "allows %s failed jobs to be reclaimed",
    (errorCode) => {
      expect(isRetryablePublishJobError(errorCode)).toBe(true);
    },
  );

  it.each([
    "invalid_credentials_or_permission",
    "validation_failed",
    "not_approved",
    "blocking_flags",
    "invalid_payload",
    "stale_plan",
    null,
  ])("does not reclaim terminal failed code %s", (errorCode) => {
    expect(isRetryablePublishJobError(errorCode)).toBe(false);
  });

  it("preserves stale_plan as a safe persisted terminal error code", () => {
    expect(sanitizePublishJobErrorCode("stale_plan")).toBe("stale_plan");
  });
});
