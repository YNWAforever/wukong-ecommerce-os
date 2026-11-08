import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeApiToken,
  fakeGetDatabase,
  fakeSessionContext,
} from "../../../../../lib/studio/test-fakes";
import { createMcpTokenRevokeHandler } from "./route";

/**
 * Route-contract tests for `DELETE /api/studio/tokens/[id]` (plan Task 12):
 * admin-only revocation, audited, 404 for unknown/foreign ids.
 */

const WORKSPACE = "ws_test";
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_MCP_SERVER_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

function fixture(input: {
  role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
  apiTokens?: ReturnType<typeof fakeApiToken>[];
} = {}) {
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
    handler: createMcpTokenRevokeHandler(deps),
    fake,
  };
}

function request(tokenId: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/studio/tokens/${tokenId}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: tokenId }) },
  ];
}

describe("DELETE /api/studio/tokens/[id]", () => {
  it("revokes a token and audits the action", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { handler, fake } = fixture({ apiTokens: [token] });
    const response = await handler(...request(token.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tokenId: token.id });
    expect(fake.state.apiTokens[0]?.revokedAt).not.toBeNull();
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.token.revoked",
    ]);
  });

  it("returns 404 for an unknown, malformed or already revoked token", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { handler } = fixture({ apiTokens: [token] });
    expect(
      (await handler(...request("00000000-0000-4000-8000-000000000000")))
        .status,
    ).toBe(404);
    expect((await handler(...request("not-a-uuid"))).status).toBe(404);
    expect((await handler(...request(token.id))).status).toBe(200);
    expect((await handler(...request(token.id))).status).toBe(404);
  });

  it("returns 403 for a non-admin", async () => {
    const token = fakeApiToken({ workspaceId: WORKSPACE });
    const { handler, fake } = fixture({
      role: "operator",
      apiTokens: [token],
    });
    const response = await handler(...request(token.id));
    expect(response.status).toBe(403);
    expect(fake.state.apiTokens[0]?.revokedAt).toBeNull();
  });
});
