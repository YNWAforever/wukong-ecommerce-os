import { describe, expect, it } from "vitest";

import { isOpsOperatorEmail, parseOpsAllowlist } from "./ops-access";

describe("pilot lead operator allowlist", () => {
  it("normalizes case and whitespace and ignores malformed entries", () => {
    expect([
      ...parseOpsAllowlist(" Ops@Example.com, second@example.test,bad,,"),
    ]).toEqual(["ops@example.com", "second@example.test"]);
  });

  it("requires an exact email match", () => {
    const list = "ops@example.com, second@example.test";
    expect(isOpsOperatorEmail("ops@example.com", list)).toBe(true);
    expect(isOpsOperatorEmail(" OPS@EXAMPLE.COM ", list)).toBe(true);
    expect(isOpsOperatorEmail("ops@example.com.evil", list)).toBe(false);
    expect(isOpsOperatorEmail("other@example.com", list)).toBe(false);
  });

  it("denies everyone when the allowlist is absent or empty", () => {
    expect(isOpsOperatorEmail("ops@example.com", undefined)).toBe(false);
    expect(isOpsOperatorEmail("ops@example.com", "")).toBe(false);
    expect(isOpsOperatorEmail(null, "ops@example.com")).toBe(false);
  });
});
