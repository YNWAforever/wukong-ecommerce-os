import { describe, expect, it } from "vitest";

import type { StudioMcpConnection } from "@wukong/db";

import type { StudioRouteDeps } from "../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
} from "../../../../../lib/studio/test-fakes";
import { createMcpConnectionStatusHandler } from "./route";

/**
 * Route-contract tests for `PATCH /api/studio/mcp-connections/[id]`
 * (plan Task 13): explicit admin approve/disable, audited, fail-closed gates.
 */

const WORKSPACE = "ws_test";
const KEY = Buffer.alloc(32, 0x01).toString("base64");
const HASH = "a".repeat(64);
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_EXTERNAL_MCP_ENABLED: "true",
  STUDIO_MCP_ENCRYPTION_KEY: KEY,
} as unknown as NodeJS.ProcessEnv;

function connection(
  overrides: Partial<StudioMcpConnection> = {},
): StudioMcpConnection {
  const createdAt = new Date("2026-11-08T10:00:00.000Z");
  return {
    id: CONNECTION_ID,
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
    status?: StudioMcpConnection["status"];
  } = {},
) {
  const fake = createFakeStudio({
    settings: { workspaceId: WORKSPACE, enabled: true },
    mcpConnections: [connection({ status: input.status ?? "draft" })],
  });
  const session = fakeSessionContext(input.role ?? "admin", {
    workspaceId: WORKSPACE,
  });
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  const handler = createMcpConnectionStatusHandler(deps);
  const patch = (body: unknown) =>
    handler(
      new Request(
        `http://localhost/api/studio/mcp-connections/${CONNECTION_ID}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ id: CONNECTION_ID }) },
    );
  return { patch, fake };
}

describe("PATCH /api/studio/mcp-connections/[id]", () => {
  it("approves a draft with the flag, workspace, key and hashes present", async () => {
    const { patch, fake } = fixture();
    const response = await patch({ status: "approved" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; approvedBy: string };
    expect(body.status).toBe("approved");
    expect(body.approvedBy).toBe("actor_ops");
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.connection.approved",
    ]);
  });

  it("fails closed with 409 while the external flag or key is missing", async () => {
    const flagOff = fixture({
      env: {
        CONVERSATION_STUDIO_ENABLED: "true",
        STUDIO_EXTERNAL_MCP_ENABLED: "",
        STUDIO_MCP_ENCRYPTION_KEY: KEY,
      } as unknown as NodeJS.ProcessEnv,
    });
    expect((await flagOff.patch({ status: "approved" })).status).toBe(409);

    const noKey = fixture({
      env: {
        CONVERSATION_STUDIO_ENABLED: "true",
        STUDIO_EXTERNAL_MCP_ENABLED: "true",
        STUDIO_MCP_ENCRYPTION_KEY: "",
      } as unknown as NodeJS.ProcessEnv,
    });
    expect((await noKey.patch({ status: "approved" })).status).toBe(409);
  });

  it("disables an approved connection and audits it", async () => {
    const { patch, fake } = fixture({ status: "approved" });
    const response = await patch({ status: "disabled" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "disabled" });
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.connection.disabled",
    ]);
  });

  it("rejects invalid bodies, non-admins and unknown ids", async () => {
    const { patch } = fixture();
    for (const body of [{}, { status: "draft" }, { status: "approved", extra: 1 }]) {
      expect((await patch(body)).status).toBe(400);
    }

    const operator = fixture({ role: "operator" });
    expect((await operator.patch({ status: "approved" })).status).toBe(403);

    const handler = createMcpConnectionStatusHandler({
      sessionContext: fakeSessionContext("admin", {
        workspaceId: WORKSPACE,
      }).port,
      getDatabase: fakeGetDatabase(
        createFakeStudio({
          settings: { workspaceId: WORKSPACE, enabled: true },
        }).repos,
      ),
      env: ON_ENV,
    });
    const missing = await handler(
      new Request("http://localhost/api/studio/mcp-connections/x", {
        method: "PATCH",
        body: JSON.stringify({ status: "approved" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) },
    );
    expect(missing.status).toBe(404);
  });
});
