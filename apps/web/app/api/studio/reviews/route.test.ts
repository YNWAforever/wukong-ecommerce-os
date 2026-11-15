import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  reviewableContent,
  reviewSnapshot,
} from "../../../../lib/studio/test-fakes";
import { createStudioReviewsHandler } from "./route";

/**
 * Route-contract tests for `POST/GET /api/studio/reviews` (2026-11-16 plan).
 * Fakes only: the deterministic guided stages run through the same fake repos
 * the service tests use, so this file pins the HTTP contract (strict bodies,
 * duplicate query rejection, role floor, bounded response shape).
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  CONVERSATION_STUDIO_AI_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;
const WORKSPACE = "ws_test";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const MISSING = "77777777-7777-4777-8777-777777777777";
const VERSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fixture(role: "operator" | "viewer" = "operator") {
  const fake = createFakeStudio({
    snapshots: {
      [A]: reviewSnapshot({
        listingId: A,
        versionId: VERSION_A,
        content: reviewableContent(),
      }),
      [B]: reviewSnapshot({
        listingId: B,
        versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        content: reviewableContent(),
      }),
    },
    settings: {
      workspaceId: WORKSPACE,
      enabled: true,
      allowedSkills: [],
      ai: {
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        pricingVersion: "opencode-go-2026-11",
        maxInputTokens: 1048576,
        inputUsdPerMillion: "0.3",
        outputUsdPerMillion: "1.2",
        maxOutputTokens: 4096,
      },
    },
  });
  const deps: StudioRouteDeps = {
    sessionContext: fakeSessionContext(role, {
      workspaceId: WORKSPACE,
    }).port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: ON_ENV,
  };
  return {
    handlers: createStudioReviewsHandler(deps),
    fake,
  };
}

function post(body: unknown): Request {
  return new Request("http://x/api/studio/reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/studio/reviews", () => {
  it("starts one bounded review and returns per-listing exact pins", async () => {
    const { handlers, fake } = fixture();
    const response = await handlers.POST(post({ listingIds: [A] }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      batchId: string;
      requested: number;
      completed: number;
      partial: number;
      failed: number;
      items: Array<{
        listingId: string;
        outcome: string;
        failureCode: string | null;
        threadId: string | null;
        audit: { outputId: string; revision: number; contentDigest: string };
        gap: { outputId: string; revision: number; contentDigest: string };
      }>;
    };
    expect(body.requested).toBe(1);
    expect(body.completed).toBe(1);
    expect(body.items[0]).toMatchObject({
      listingId: A,
      outcome: "complete",
      failureCode: null,
    });
    expect(body.items[0]?.threadId).toEqual(expect.any(String));
    expect(body.items[0]?.audit.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.items[0]?.gap.outputId).not.toBe(body.items[0]?.audit.outputId);
    expect(fake.state.threads).toHaveLength(1);
    // No caller-controlled fields, no model: only the recorded determinism.
    expect(fake.state.budgets).toEqual([]);
  });

  it("rejects a strict, over-cap or duplicate body without creating a thread", async () => {
    const { handlers, fake } = fixture();
    for (const body of [
      { listingIds: [A], workspaceId: "ws_foreign" },
      { listingIds: [A, A] },
      { listingIds: [A, B, MISSING, A, B, MISSING] },
      { listingIds: [A, "not-a-uuid"] },
      { listingIds: [] },
    ]) {
      const response = await handlers.POST(post(body));
      expect(response.status).toBe(400);
      const error = (await response.json()) as { code: string };
      expect(error.code).toBe("invalid_body");
    }
    const malformed = await handlers.POST(
      new Request("http://x/api/studio/reviews", {
        method: "POST",
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(fake.state.threads).toEqual([]);
  });

  it("refuses a viewer before any review work", async () => {
    const { handlers, fake } = fixture("viewer");
    const response = await handlers.POST(post({ listingIds: [A] }));
    expect(response.status).toBe(403);
    expect(fake.state.threads).toEqual([]);
  });
});

describe("GET /api/studio/reviews", () => {
  it("reads recorded state for the requested listings", async () => {
    const { handlers } = fixture();
    await handlers.POST(post({ listingIds: [A] }));
    const response = await handlers.GET(
      new Request(`http://x/api/studio/reviews?listingIds=${A},${MISSING}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        listingId: string;
        available: boolean;
        threadId: string | null;
        audit: { contentDigest: string } | null;
        gap: { contentDigest: string } | null;
      }>;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ listingId: A, available: true });
    expect(body.items[0]?.threadId).toEqual(expect.any(String));
    expect(body.items[0]?.audit).not.toBeNull();
    expect(body.items[1]).toMatchObject({
      listingId: MISSING,
      available: false,
      threadId: null,
      audit: null,
      gap: null,
    });
  });

  it("rejects invalid, duplicated or over-cap query parameters", async () => {
    const { handlers } = fixture();
    for (const query of [
      "",
      "?listingIds=",
      `?listingIds=${A},${A}`,
      "?listingIds=not-a-uuid",
      `?listingIds=${A}&listingIds=${B}`,
      "?other=1",
    ]) {
      const response = await handlers.GET(
        new Request(`http://x/api/studio/reviews${query}`),
      );
      expect(response.status).toBe(400);
    }
  });
});
