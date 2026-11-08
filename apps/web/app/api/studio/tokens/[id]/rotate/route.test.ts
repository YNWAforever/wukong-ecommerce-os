import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeApiToken,
  fakeGetDatabase,
  fakeSessionContext,
} from "../../../../../../lib/studio/test-fakes";
import { createMcpTokenRotateHandler } from "./route";

/**
 * Route-contract tests for `POST /api/studio/tokens/[id]/rotate` (B4):
 * admin-only, creates a replacement with the same label/scopes/quotas,
 * revokes the old token, returns the new plaintext once, and audits.
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
  return { handler: createMcpTokenRotateHandler(deps), fake };
}

function rotate(
  tokenId: string,
): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/studio/tokens/${tokenId}/rotate`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: tokenId }) },
  ];
}

describe("POST /api/studio/tokens/[id]/rotate", () => {
  it("revokes the old token and returns the replacement plaintext once", async () => {
    const token = fakeApiToken({
      workspaceId: WORKSPACE,
      label: "Claude Desktop",
      scopes: ["read", "propose"],
      rateLimitPerMinute: 60,
      monthlyCallQuota: 1000,
    });
    const { handler, fake } = fixture({ apiTokens: [token] });

    const response = await handler(...rotate(token.id));
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      token: string;
      tokenId: string;
      label: string;
      scopes: string[];
      rateLimitPerMinute: number | null;
      monthlyCallQuota: number | null;
      usage: { minuteCalls: number; monthCalls: number };
    };
    expect(body.token).toMatch(/^wuk_[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/);
    expect(body.tokenId).not.toBe(token.id);
    expect(body.label).toBe("Claude Desktop");
    expect(body.scopes).toEqual(["read", "propose"]);
    expect(body.rateLimitPerMinute).toBe(60);
    expect(body.monthlyCallQuota).toBe(1000);
    expect(body.usage).toEqual({ minuteCalls: 0, monthCalls: 0 });

    const old = fake.state.apiTokens.find((entry) => entry.id === token.id);
    expect(old?.revokedAt).not.toBeNull();
    const replacement = fake.state.apiTokens.find(
      (entry) => entry.id === body.tokenId,
    );
    expect(replacement?.revokedAt).toBeNull();
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.token.rotated",
    ]);
    expect(fake.state.audits[0]?.metadata).toMatchObject({
      tokenId: token.id,
      replacementTokenId: body.tokenId,
    });
  });

  it("returns 404 for unknown/malformed ids, 409 for a revoked token and 403 for a non-admin", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const revoked = fakeApiToken({
      workspaceId: WORKSPACE,
      revokedAt: new Date(),
    });
    const { handler } = fixture({ apiTokens: [token, revoked] });
    expect(
      (await handler(...rotate("00000000-0000-4000-8000-000000000000"))).status,
    ).toBe(404);
    expect((await handler(...rotate("not-a-uuid"))).status).toBe(404);
    expect((await handler(...rotate(revoked.id))).status).toBe(409);

    const operator = fixture({
      role: "operator",
      apiTokens: [fakeApiToken({ workspaceId: WORKSPACE })],
    });
    expect(
      (await operator.handler(...rotate(operator.fake.state.apiTokens[0]!.id)))
        .status,
    ).toBe(403);
  });

  it("keeps the token secret out of the list response shape", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { handler } = fixture({ apiTokens: [token] });
    const response = await handler(...rotate(token.id));
    expect(response.status).toBe(201);
    const text = JSON.stringify(await response.json());
    // Count occurrences of the plaintext key: exactly one, top-level.
    expect(text.match(/"token":/g)).toHaveLength(1);
  });
});
