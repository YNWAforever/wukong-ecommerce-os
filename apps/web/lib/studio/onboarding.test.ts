import { describe, expect, it } from "vitest";

import {
  buildStudioOnboarding,
  type StudioOnboardingFacts,
} from "./onboarding";

const DONE: StudioOnboardingFacts = {
  connectionPresent: true,
  reviewerCount: 1,
  listingCount: 2,
  artifactCount: 1,
  signedOffCount: 1,
  exportCount: 1,
};

const EMPTY: StudioOnboardingFacts = {
  connectionPresent: false,
  reviewerCount: 0,
  listingCount: 0,
  artifactCount: 0,
  signedOffCount: 0,
  exportCount: 0,
};

const UNKNOWN: StudioOnboardingFacts = {
  connectionPresent: null,
  reviewerCount: null,
  listingCount: null,
  artifactCount: null,
  signedOffCount: null,
  exportCount: null,
};

describe("buildStudioOnboarding", () => {
  it("reports six done steps with admin/operator links for an owner", () => {
    const result = buildStudioOnboarding(DONE, "owner");
    expect(result.status).toBe("ready");
    expect(result.done).toBe(6);
    expect(result.unknown).toBe(0);
    expect(result.steps.map((step) => step.href)).toEqual([
      "/admin",
      "/admin",
      "/listings/import",
      "/studio/reviews",
      "/studio/outputs",
      "/batches",
    ]);
  });

  it("never offers a mutating link to a viewer and names the responsible role", () => {
    const result = buildStudioOnboarding(EMPTY, "viewer");
    expect(result.done).toBe(0);
    expect(result.steps.every((step) => step.href === null)).toBe(true);
    expect(result.steps.map((step) => step.owner)).toEqual([
      "admin",
      "admin",
      "operator",
      "operator",
      "reviewer",
      "operator",
    ]);
  });

  it("lets an operator act on catalog work but not sign-off or admin setup", () => {
    const result = buildStudioOnboarding(EMPTY, "operator");
    const hrefs = Object.fromEntries(
      result.steps.map((step) => [step.key, step.href]),
    );
    expect(hrefs).toMatchObject({
      store: null,
      reviewer: null,
      catalog: "/listings/import",
      review: "/studio/reviews",
      signoff: null,
      export: "/batches",
    });
  });

  it("lets a reviewer sign off while keeping admin-only links hidden", () => {
    const result = buildStudioOnboarding(EMPTY, "reviewer");
    const hrefs = Object.fromEntries(
      result.steps.map((step) => [step.key, step.href]),
    );
    expect(hrefs).toMatchObject({
      store: null,
      reviewer: null,
      signoff: "/studio/outputs",
      export: "/batches",
    });
  });

  it("excludes unknown sources from progress instead of treating them as done or zero", () => {
    const result = buildStudioOnboarding(
      { ...DONE, connectionPresent: null, reviewerCount: null },
      "owner",
    );
    expect(result.status).toBe("ready");
    expect(result.done).toBe(4);
    expect(result.unknown).toBe(2);
    expect(result.steps[0]?.state).toBe("unknown");
    expect(result.steps[1]?.state).toBe("unknown");
  });

  it("reports unavailable only when every source failed", () => {
    const result = buildStudioOnboarding(UNKNOWN, "owner");
    expect(result.status).toBe("unavailable");
    expect(result.done).toBe(0);
    expect(result.unknown).toBe(6);
    expect(result.total).toBe(6);
  });
});
