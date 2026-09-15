import { describe, expect, it } from "vitest";

import {
  APPROVAL_INVALIDATED_ACTION,
  APPROVAL_INVALIDATION_CAUSES,
  isApprovalInvalidationCause,
} from "./approval-invalidation.js";

describe("approval invalidation vocabulary", () => {
  it("names the audit action", () => {
    expect(APPROVAL_INVALIDATED_ACTION).toBe("listing.approval_invalidated");
  });

  it("lists exactly the three causes", () => {
    expect([...APPROVAL_INVALIDATION_CAUSES]).toEqual([
      "confirmation_changed",
      "source_reimported_changed",
      "source_reimported_unchanged",
    ]);
  });

  it("recognises only known causes", () => {
    expect(isApprovalInvalidationCause("confirmation_changed")).toBe(true);
    expect(isApprovalInvalidationCause("something_else")).toBe(false);
    expect(isApprovalInvalidationCause(null)).toBe(false);
  });
});
