import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeApiToken,
  fakeGetDatabase,
  fakeSessionContext,
} from "../../../../lib/studio/test-fakes";
import { createMcpTokenHandlers } from "./route";

/**
 * Route-contract tests for `GET/POST /api/studio/tokens` (plan Task 12):
 * admin-only, strict body, one-time plaintext and no plaintext in list.
 */

const WORKSPACE = "ws_test";
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_MCP_SERVER_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

function fixture(
  input: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    env?: NodeJS.ProcessEnv;
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
    env: input.env ?? ON_ENV,
  };
  const handlers = createMcpTokenHandlers(deps);
  return { handlers, fake };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/studio/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const createBody = { label: "Automation", scopes: ["read"] };

describe("POST /api/studio/tokens", () => {
  it("creates a token and returns the plaintext exactly once", async () => {
    const { handlers, fake } = fixture();
    const response = await handlers.POST(post(createBody));
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      tokenId: string;
      token: string;
      prefix: string;
      scopes: string[];
      label: string;
      revokedAt: string | null;
    };
    expect(body.token).toMatch(/^wuk_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(body.prefix.length).toBe(12);
    expect(body.scopes).toEqual(["read"]);
    expect(body.label).toBe("Automation");
    expect(body.revokedAt).toBeNull();
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.token.created",
    ]);
  });

  it("rejects invalid bodies, non-admins and a disabled workspace", async () => {
    const invalid = fixture();
    for (const body of [
      {},
      { label: "", scopes: ["read"] },
      { label: "x", scopes: [] },
      { label: "x", scopes: ["write"] },
      { label: "x", scopes: ["read"], extra: "no" },
    ]) {
      const response = await invalid.handlers.POST(post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_body" });
    }
    expect(invalid.fake.state.apiTokens).toEqual([]);

    for (const role of ["viewer", "operator", "reviewer"] as const) {
      const response = await fixture({ role }).handlers.POST(post(createBody));
      expect(response.status).toBe(403);
    }

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect((await disabled.handlers.POST(post(createBody))).status).toBe(404);
    expect(disabled.fake.state.apiTokens).toEqual([]);
  });
});

describe("GET /api/studio/tokens", () => {
  it("lists metadata only for an admin", async () => {
    const token = fakeApiToken({
      workspaceId: WORKSPACE,
      label: "Existing",
      prefix: "existingpref",
    });
    const { handlers } = fixture({ apiTokens: [token] });
    const response = await handlers.GET(
      new Request("http://localhost/api/studio/tokens"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toEqual([
      expect.objectContaining({
        tokenId: token.id,
        label: "Existing",
        prefix: "existingpref",
      }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("wuk_");
    expect(serialized).not.toContain("tokenHash");
  });

  it("returns 403 for an operator", async () => {
    const response = await fixture({ role: "operator" }).handlers.GET(
      new Request("http://localhost/api/studio/tokens"),
    );
    expect(response.status).toBe(403);
  });
});
