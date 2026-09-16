import { describe, expect, it } from "vitest";
import * as core from "./index.js";

const profile = {
  name: "Test",
  currency: "HKD",
  locales: ["en", "zh-Hant"],
  tone: "clear",
  claimPolicy: [],
  requiredFields: [],
};
const api = core;

describe("reviewed wine operation budget", () => {
  it.each(["full", "research", "copy", "section"] as const)(
    "reserves reviewed whole-context costs for %s",
    (mode) => {
      expect(api.wineOperationBudget).toBeTypeOf("function");
      expect(api.wineOperationBudget(mode)).toEqual(
        mode === "full" || mode === "research"
          ? { goPhysicalCalls: 10, goReservedUsd: "3.194880", tavilyCredits: 5 }
          : { goPhysicalCalls: 4, goReservedUsd: "1.277952", tavilyCredits: 0 },
      );
      expect(Object.isFrozen(api.wineOperationBudget(mode))).toBe(true);
    },
  );
  it("rejects unknown modes at runtime", () => {
    expect(api.wineOperationBudget).toBeTypeOf("function");
    expect(() => api.wineOperationBudget("legacy" as core.WineMode)).toThrow();
  });
  it("freezes and validates exact immutable mode budgets without accepting overrides", () => {
    expect(api.createWineBudgetSnapshot).toBeTypeOf("function");
    for (const mode of ["full", "research", "copy", "section"] as const) {
      const snapshot = api.createWineBudgetSnapshot(mode);
      expect(snapshot).toEqual({
        schemaVersion: 1,
        mode,
        ...api.wineOperationBudget(mode),
      });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(api.wineBudgetSnapshotSchema.safeParse(snapshot).success).toBe(
        true,
      );
      for (const change of [
        { goPhysicalCalls: 11 },
        { goReservedUsd: "0.1" },
        { tavilyCredits: 6 },
        { ceiling: 20 },
        { schemaVersion: 2 },
      ]) {
        expect(
          api.wineBudgetSnapshotSchema.safeParse({ ...snapshot, ...change })
            .success,
        ).toBe(false);
      }
    }
    expect(
      api.wineBudgetSnapshotSchema.safeParse({
        ...api.createWineBudgetSnapshot("full"),
        mode: "copy",
      }).success,
    ).toBe(false);
  });
});

describe("server-owned wine policy", () => {
  it("preserves absent legacy profiles and defaults explicit policy to disabled with zero search allowance", () => {
    expect(
      core.workspaceProfileSchema.parse(profile).wineEnrichment,
    ).toBeUndefined();
    const parsed = core.workspaceProfileSchema.parse({
      ...profile,
      wineEnrichment: {},
    });
    expect(parsed.wineEnrichment).toMatchObject({
      enabled: false,
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      maxOutputTokens: 4096,
      budgetCapUsd: "10",
      tavilyCreditCap: 0,
      allowedDomains: [],
      rulesVersion: "wine-grounding@1",
    });
  });
  it.each([
    { provider: "openai" },
    { model: "other" },
    { maxInputTokens: 1000 },
    { inputUsdPerMillion: 0.15 },
    { outputUsdPerMillion: 0 },
    { maxOutputTokens: 8192 },
    { budgetCapUsd: "11" },
    { tavilyCreditCap: -1 },
    { tavilyCreditCap: 0.5 },
    { rulesVersion: "other" },
    { policyVersion: "" },
    { allowedDomains: ["https://example.com"] },
    { goPhysicalCalls: 11 },
    { apiKey: "not-a-real-key" },
  ])("rejects unsupported policy configuration %j", (wineEnrichment) => {
    expect(
      core.workspaceProfileSchema.safeParse({ ...profile, wineEnrichment })
        .success,
    ).toBe(false);
  });
  it("snapshots policy values separately from mutable caller configuration", () => {
    expect(api.wineEnrichmentPolicySchema).toBeDefined();
    const supplied = {
      enabled: true,
      tavilyCreditCap: 5,
      allowedDomains: ["Example.com"],
      policyVersion: "merchant-policy@2",
    };
    const parsed = api.wineEnrichmentPolicySchema.parse(supplied);
    supplied.allowedDomains.push("changed.com");
    expect(parsed.allowedDomains).toEqual(["example.com"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.allowedDomains)).toBe(true);
    const editablePolicy = {
      name: profile.name,
      tone: profile.tone,
      claimPolicy: [],
      requiredFields: [],
      sourcePreferences: { allowedDomains: [] },
    };
    expect(core.workspacePolicySchema.safeParse(editablePolicy).success).toBe(
      true,
    );
    expect(() =>
      core.workspacePolicySchema.parse({
        ...editablePolicy,
        sourcePreferences: { allowedDomains: [] },
        wineEnrichment: {},
      }),
    ).toThrow();
  });
  it("preserves the legacy four-call Go reservation and existing policy ceiling enforcement", () => {
    const listingAi = {
      provider: "opencode-go" as const,
      model: "deepseek-v4.1-flash",
      pricingVersion: "2026-09-16",
      maxInputTokens: 1048576,
      maxOutputTokens: 4096,
      inputUsdPerMillion: 0.3,
      outputUsdPerMillion: 1.2,
      runCeilingUsd: "1.277952",
      budgetCapUsd: "10",
    };
    expect(core.paidListingReservation(listingAi)).toBe("1.277952");
    expect(() =>
      core.paidListingReservation({ ...listingAi, runCeilingUsd: "1" }),
    ).toThrow("run_ceiling_too_small");
  });
});
