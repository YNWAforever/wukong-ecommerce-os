import { describe, expect, it } from "vitest";
import { summarizeWorkspaceReadiness } from "./workspace-readiness-summary";
const now = new Date("2026-10-01T10:00:00.000Z");
const profile = {
  name: "Synthetic",
  currency: "HKD" as const,
  locales: ["en", "zh-Hant"],
  tone: "Plain",
  claimPolicy: [],
  requiredFields: [],
};
const observations = {
  reviewerCount: 1,
  connectionPresent: true,
  latestAi: null,
  latestQueueStep: null,
};
const input = {
  now,
  profile: profile as any,
  observations,
  env: { AI_PROVIDER: "fake" },
};
describe("workspace readiness observations", () => {
  it("does not promote configured or synthetic adapters to verified health", () => {
    const result = summarizeWorkspaceReadiness(input);
    expect(result.map((item) => [item.key, item.state])).toEqual([
      ["ai", "unknown"],
      ["queue", "unknown"],
      ["storage", "unknown"],
      ["shopline", "unknown"],
      ["reviewer", "ready"],
    ]);
    expect(result.find((item) => item.key === "storage")?.checkedAt).toBeNull();
    expect(result.find((item) => item.key === "reviewer")?.checkedAt).toBe(
      "2026-10-01T10:00:00.000Z",
    );
  });
  it("reports observed missing reviewers and connections as actionable blocks", () => {
    const result = summarizeWorkspaceReadiness({
      ...input,
      observations: {
        ...observations,
        reviewerCount: 0,
        connectionPresent: false,
      },
      env: { AI_PROVIDER: "openai", LISTING_PAID_OPERATIONS_ENABLED: "false" },
    });
    expect(result.find((item) => item.key === "reviewer")?.state).toBe(
      "blocked",
    );
    expect(result.find((item) => item.key === "shopline")?.state).toBe(
      "blocked",
    );
    expect(result.find((item) => item.key === "ai")?.state).toBe("blocked");
    expect(result.every((item) => item.safeReason && item.nextAction)).toBe(
      true,
    );
  });
  it("reports recent worker completion with its actual timestamp but expires old observations", () => {
    const recent = {
      state: "completed",
      checkedAt: new Date("2026-10-01T09:58:00.000Z"),
    };
    const result = summarizeWorkspaceReadiness({
      ...input,
      observations: { ...observations, latestQueueStep: recent },
    });
    expect(result.find((item) => item.key === "queue")).toMatchObject({
      state: "ready",
      checkedAt: "2026-10-01T09:58:00.000Z",
    });
    const stale = summarizeWorkspaceReadiness({
      ...input,
      observations: {
        ...observations,
        latestQueueStep: {
          ...recent,
          checkedAt: new Date("2026-09-30T09:58:00Z"),
        },
      },
    });
    expect(stale.find((item) => item.key === "queue")?.state).toBe("unknown");
  });
  it("keeps unobservable systems unknown even when observations cannot be read", () => {
    expect(
      summarizeWorkspaceReadiness({ ...input, observations: null }).every(
        (item) => item.state === "unknown" && item.checkedAt === null,
      ),
    ).toBe(true);
  });
  it("requires a recent observation for the exact admitted model and treats failures as blocked", () => {
    const configured = {
      ...profile,
      listingAi: {
        provider: "openai",
        model: "gpt-4o",
        pricingVersion: "synthetic-pricing",
        runCeilingUsd: "2",
        budgetCapUsd: "20",
        maxInputTokens: 128000,
        inputUsdPerMillion: 2.5,
        outputUsdPerMillion: 10,
        maxOutputTokens: 1024,
      },
    } as any;
    const enabled = {
      AI_PROVIDER: "openai",
      LISTING_PAID_OPERATIONS_ENABLED: "true",
    };
    const check = (latestAi: any) =>
      summarizeWorkspaceReadiness({
        ...input,
        profile: configured,
        env: enabled,
        observations: { ...observations, latestAi },
      }).find((item) => item.key === "ai");
    expect(check(null)?.state).toBe("unknown");
    const succeeded = {
      provider: "openai",
      model: "gpt-4o",
      status: "succeeded",
      checkedAt: new Date("2026-10-01T09:59:00Z"),
    };
    expect(check(succeeded)).toMatchObject({
      state: "ready",
      checkedAt: "2026-10-01T09:59:00.000Z",
    });
    expect(check({ ...succeeded, status: "failed" })?.state).toBe("blocked");
    expect(check({ ...succeeded, model: "other-model" })?.state).toBe(
      "unknown",
    );
    expect(
      check({ ...succeeded, checkedAt: new Date("2026-09-30T09:59:00Z") })
        ?.state,
    ).toBe("unknown");
  });
});
