import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "../../../../lib/studio/test-fakes";
import type { StudioMcpConnection } from "@wukong/db";
import { createMcpConnectionHandlers } from "./route";

/**
 * Route-contract tests for `GET/POST /api/studio/mcp-connections`
 * (plan Task 13): admin-only, strict bodies, honest disabled snapshot and the
 * draft success shape.
 */

const WORKSPACE = "ws_test";
const HASH = "a".repeat(64);
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_EXTERNAL_MCP_ENABLED: "false",
} as unknown as NodeJS.ProcessEnv;

function connection(
  overrides: Partial<StudioMcpConnection> = {},
): StudioMcpConnection {
  const createdAt = new Date("2026-11-08T10:00:00.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: WORKSPACE,
    label: "External catalogue",
    endpointUrl: "https://mcp.example.test/rpc",
    transport: "http",
    status: "draft",
    generation: 1,
    toolAllowlist: ["catalog.search"],
    schemaHashes: { "catalog.search": HASH },
    credentialEnvelope: null,
    createdBy: "actor_ops",
    approvedBy: null,
    approvedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function fixture(
  input: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    env?: NodeJS.ProcessEnv;
    options?: FakeStudioOptions;
  } = {},
) {
  const fake = createFakeStudio({
    ...(input.options ?? {}),
    settings: { workspaceId: WORKSPACE, enabled: true },
  });
  const session = fakeSessionContext(input.role ?? "admin", {
    workspaceId: WORKSPACE,
  });
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  return {
    handlers: createMcpConnectionHandlers(deps),
    fake,
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/studio/mcp-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const createBody = {
  label: "External catalogue",
  endpointUrl: "https://mcp.example.test/rpc",
  transport: "http",
  toolAllowlist: ["catalog.search"],
  schemaHashes: { "catalog.search": HASH },
};

describe("GET /api/studio/mcp-connections", () => {
  it("returns connection metadata and the honest disabled gate state", async () => {
    const { handlers } = fixture({ options: { mcpConnections: [connection()] } });
    const response = await handlers.GET(
      new Request("http://localhost/api/studio/mcp-connections"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      externalFlagOn: boolean;
      approvable: boolean;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      label: "External catalogue",
      status: "draft",
    });
    expect(body.externalFlagOn).toBe(false);
    expect(body.approvable).toBe(false);
    expect(JSON.stringify(body)).not.toContain("credentialEnvelope");
  });

  it("returns 403 for a non-admin and 404 when Studio is disabled", async () => {
    const operator = fixture({ role: "operator" });
    expect(
      (
        await operator.handlers.GET(
          new Request("http://localhost/api/studio/mcp-connections"),
        )
      ).status,
    ).toBe(403);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect(
      (
        await disabled.handlers.GET(
          new Request("http://localhost/api/studio/mcp-connections"),
        )
      ).status,
    ).toBe(404);
  });
});

describe("POST /api/studio/mcp-connections", () => {
  it("creates a draft connection with an audit event", async () => {
    const { handlers, fake } = fixture();
    const response = await handlers.POST(post(createBody));
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      connectionId: string;
      status: string;
      label: string;
    };
    expect(body.status).toBe("draft");
    expect(body.label).toBe("External catalogue");
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.connection.created",
    ]);
  });

  it("rejects invalid bodies, non-https endpoints, non-admins and disabled Studio", async () => {
    const invalid = fixture();
    for (const body of [
      {},
      { ...createBody, label: "" },
      { ...createBody, endpointUrl: "http://mcp.example.test/rpc" },
      { ...createBody, toolAllowlist: [] },
      { ...createBody, schemaHashes: { "catalog.search": "nope" } },
      { ...createBody, extra: true },
    ]) {
      const response = await invalid.handlers.POST(post(body));
      expect(response.status).toBe(400);
    }
    expect(invalid.fake.state.mcpConnections).toEqual([]);

    const operator = fixture({ role: "operator" });
    expect((await operator.handlers.POST(post(createBody))).status).toBe(403);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect((await disabled.handlers.POST(post(createBody))).status).toBe(404);
  });
});
