import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "../../../../lib/studio/test-fakes";
import { createStudioOverviewHandler } from "./route";

/**
 * Route-contract tests for `GET /api/studio/overview` (plan Task 6): the home
 * strip is viewer-readable, deterministic and never reserves budget.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const NOW = new Date("2026-11-08T10:00:00.000Z");

function fixture(input: {
  options?: FakeStudioOptions;
  env?: NodeJS.ProcessEnv;
  session?: "viewer" | "operator";
} = {}) {
  const fake = createFakeStudio({
    ...(input.options ?? {}),
    settings: {
      workspaceId: "ws_test",
      enabled: true,
      monthlyBudgetUsd: "5.000000",
      ai: {
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        pricingVersion: "go-2026-11",
        maxInputTokens: 1048576,
        inputUsdPerMillion: "0.3",
        outputUsdPerMillion: "1.2",
        maxOutputTokens: 4096,
      },
    },
  });
  const session = fakeSessionContext(input.session ?? "viewer");
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  return { handler: createStudioOverviewHandler(deps), fake };
}

const request = () => new Request("http://localhost/api/studio/overview");

describe("GET /api/studio/overview", () => {
  it("returns deterministic counts, quality and jobs with deep links", async () => {
    const { handler, fake } = fixture({
      options: {
        counts: { in_review: 2, approved: 1, published: 4 },
        pipelineRuns: [
          {
            id: "job-1",
            listingId: "listing-1",
            versionId: null,
            status: "failed",
            errorCode: "provider_error",
            createdAt: NOW,
          },
        ],
      },
    });
    const response = await handler(request());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      listingCounts: {
        byStatus: Record<string, number>;
        total: number;
        deepLink: string;
      };
      quality: { totalListings: number; projectionState: string; deepLink: string };
      recentJobs: {
        items: Array<{ jobId: string; state: string; deepLink: string }>;
        deepLink: string;
      };
    };
    expect(body.listingCounts.total).toBe(7);
    expect(body.listingCounts.byStatus.in_review).toBe(2);
    expect(body.listingCounts.deepLink).toBe("/dashboard");
    expect(body.quality.totalListings).toBe(3);
    expect(body.quality.deepLink).toBe("/quality");
    expect(body.recentJobs.items).toEqual([
      {
        jobId: "job-1",
        state: "failed",
        createdAt: NOW.toISOString(),
        deepLink: "/jobs",
      },
    ]);
    expect(body.recentJobs.deepLink).toBe("/jobs");
    expect(fake.state.writes).not.toContain("budget.reserve");
    expect(fake.state.writes).not.toContain("budget.settle");
  });

  it("returns 404 when Studio is disabled and 401 without a session", async () => {
    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    const response = await disabled.handler(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });

    const anonymous = createStudioOverviewHandler({
      sessionContext: { async resolve() { return null; } },
      getDatabase: () => {
        throw new Error("must stay lazy");
      },
      env: ON_ENV,
    });
    expect((await anonymous(request())).status).toBe(401);
  });
});

