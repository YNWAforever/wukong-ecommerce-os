import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeApiToken,
  fakeGetDatabase,
  fakeSessionContext,
} from "../../../../../lib/studio/test-fakes";
import { createMcpTokenHandler } from "./route";

/**
 * Route-contract tests for `DELETE`/`PATCH /api/studio/tokens/[id]`
 * (plan Task 12; B4 adds quota editing): admin-only, audited, 404 for
 * unknown/foreign ids, 409 for a revoked token.
 */

const WORKSPACE = "ws_test";
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_MCP_SERVER_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

function fixture(
  input: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    apiTokens?: ReturnType<typeof fakeApiToken>[];
  } = {},
) {
  const fake = createFakeStudio({
    settings: { workspaceId: WORKSPACE, enabled: true },
    apiTokens: input.apiTokens ?? [],
  });
  const session = fakeSessionContext(input.role ?? "admin", {
    workspaceId: WORKSPACE,
  });
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: ON_ENV,
  };
  return {
    handlers: createMcpTokenHandler(deps),
    fake,
  };
}

function context(tokenId: string) {
  return { params: Promise.resolve({ id: tokenId }) };
}

function request(method: "DELETE" | "PATCH", body?: unknown): Request {
  return new Request("http://localhost/api/studio/tokens/token", {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

describe("DELETE /api/studio/tokens/[id]", () => {
  it("revokes a token and audits the action", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { handlers, fake } = fixture({ apiTokens: [token] });
    const response = await handlers.DELETE(
      request("DELETE"),
      context(token.id),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tokenId: token.id });
    expect(fake.state.apiTokens[0]?.revokedAt).not.toBeNull();
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.token.revoked",
    ]);
  });

  it("returns 404 for an unknown, malformed or already revoked token", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { handlers } = fixture({ apiTokens: [token] });
    expect(
      (
        await handlers.DELETE(
          request("DELETE"),
          context("00000000-0000-4000-8000-000000000000"),
        )
      ).status,
    ).toBe(404);
    expect(
      (await handlers.DELETE(request("DELETE"), context("not-a-uuid"))).status,
    ).toBe(404);
    expect(
      (await handlers.DELETE(request("DELETE"), context(token.id))).status,
    ).toBe(200);
    expect(
      (await handlers.DELETE(request("DELETE"), context(token.id))).status,
    ).toBe(404);
  });

  it("returns 403 for a non-admin", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { handlers, fake } = fixture({
      role: "operator",
      apiTokens: [token],
    });
    const response = await handlers.DELETE(
      request("DELETE"),
      context(token.id),
    );
    expect(response.status).toBe(403);
    expect(fake.state.apiTokens[0]?.revokedAt).toBeNull();
  });
});

describe("PATCH /api/studio/tokens/[id]", () => {
  it("updates both quota limits, returns the server readback and audits", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { handlers, fake } = fixture({ apiTokens: [token] });
    const response = await handlers.PATCH(
      request("PATCH", { rateLimitPerMinute: 60, monthlyCallQuota: 1000 }),
      context(token.id),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      tokenId: token.id,
      rateLimitPerMinute: 60,
      monthlyCallQuota: 1000,
    });
    expect(body.token).toBeUndefined();
    expect(fake.state.apiTokens[0]?.rateLimitPerMinute).toBe(60);
    const audit = fake.state.audits[0];
    expect(audit?.action).toBe("studio.mcp.token.limits_updated");
    expect(audit?.metadata).toMatchObject({
      rateLimitPerMinute: 60,
      monthlyCallQuota: 1000,
      previousRateLimitPerMinute: null,
      previousMonthlyCallQuota: null,
    });
  });

  it("clears limits to unlimited with explicit nulls", async () => {
    const token = fakeApiToken({
      workspaceId: WORKSPACE,
      rateLimitPerMinute: 10,
      monthlyCallQuota: 50,
    });
    const { handlers, fake } = fixture({ apiTokens: [token] });
    const response = await handlers.PATCH(
      request("PATCH", { rateLimitPerMinute: null, monthlyCallQuota: null }),
      context(token.id),
    );
    expect(response.status).toBe(200);
    expect(fake.state.apiTokens[0]?.rateLimitPerMinute).toBeNull();
    expect(fake.state.apiTokens[0]?.monthlyCallQuota).toBeNull();
  });

  it("rejects invalid bodies, non-admins, unknown ids and revoked tokens", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const revoked = fakeApiToken({
      workspaceId: WORKSPACE,
      revokedAt: new Date(),
    });
    const { handlers } = fixture({ apiTokens: [token, revoked] });
    for (const body of [
      {},
      { rateLimitPerMinute: 0, monthlyCallQuota: 10 },
      { rateLimitPerMinute: 601, monthlyCallQuota: 10 },
      { rateLimitPerMinute: 10, monthlyCallQuota: 1_000_001 },
      { rateLimitPerMinute: 10.5, monthlyCallQuota: 10 },
      { rateLimitPerMinute: 10, monthlyCallQuota: 10, extra: true },
    ]) {
      expect(
        (await handlers.PATCH(request("PATCH", body), context(token.id)))
          .status,
      ).toBe(400);
    }
    expect(
      (
        await handlers.PATCH(
          request("PATCH", { rateLimitPerMinute: 10, monthlyCallQuota: 10 }),
          context("00000000-0000-4000-8000-000000000000"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handlers.PATCH(
          request("PATCH", { rateLimitPerMinute: 10, monthlyCallQuota: 10 }),
          context(revoked.id),
        )
      ).status,
    ).toBe(409);

    const operator = fixture({
      role: "operator",
      apiTokens: [fakeApiToken({ workspaceId: WORKSPACE })],
    });
    expect(
      (
        await operator.handlers.PATCH(
          request("PATCH", { rateLimitPerMinute: 10, monthlyCallQuota: 10 }),
          context(operator.fake.state.apiTokens[0]!.id),
        )
      ).status,
    ).toBe(403);
  });
});
