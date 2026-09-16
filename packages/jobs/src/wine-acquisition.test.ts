import { describe, expect, it } from "vitest";
import {
  wineAcquisitionPolicySchema,
  wineSearchDiagnosticSchema,
  wineSearchOutputSchema,
} from "./wine-acquisition.js";
const policy = {
  schemaVersion: 1,
  deadlineAt: new Date().toISOString(),
  policyVersion: "v1",
  rulesVersion: "v1",
  allowedDomains: ["example.test"],
};
describe("accepted acquisition coordinates", () => {
  it("has strict versioned policy coordinates", () => {
    expect(wineAcquisitionPolicySchema.parse(policy)).toEqual(policy);
    expect(
      wineAcquisitionPolicySchema.safeParse({ ...policy, apiKey: "private" })
        .success,
    ).toBe(false);
  });
  it.each([
    [],
    ["Example.test"],
    ["https://example.test"],
    ["example.test:443"],
  ])("rejects ambiguous domain lists %j", (allowedDomains) =>
    expect(
      wineAcquisitionPolicySchema.safeParse({ ...policy, allowedDomains })
        .success,
    ).toBe(false),
  );
});
describe("bounded terminal search persistence", () => {
  const output = {
    schemaVersion: 1,
    requestId: "request-1",
    results: [
      {
        url: "https://example.test/wine",
        title: "Wine",
        content: "evidence",
        truncated: false,
      },
    ],
  };
  it("accepts only normalized output", () => {
    expect(wineSearchOutputSchema.parse(output)).toEqual(output);
    expect(
      wineSearchOutputSchema.safeParse({ ...output, query: "secret" }).success,
    ).toBe(false);
    expect(
      wineSearchOutputSchema.safeParse({
        ...output,
        results: [{ ...output.results[0], rawContent: "raw" }],
      }).success,
    ).toBe(false);
  });
  it("requires a marker when retained text was truncated", () =>
    expect(
      wineSearchOutputSchema.safeParse({
        ...output,
        results: [{ ...output.results[0], truncated: true }],
      }).success,
    ).toBe(false));
  it("retains only numeric usage and enum diagnostics", () => {
    const value = {
      schemaVersion: 1,
      code: "cost_discrepancy",
      requestId: null,
      measuredCredits: 4,
      reservedCredits: 1,
      httpStatus: 200,
    };
    expect(wineSearchDiagnosticSchema.parse(value)).toEqual(value);
    expect(
      wineSearchDiagnosticSchema.safeParse({
        ...value,
        message: "provider body",
      }).success,
    ).toBe(false);
  });
});
