import { describe, expect, it } from "vitest";

import type { StudioMcpConnection } from "@wukong/db";

import type { StudioRouteDeps } from "../../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
} from "../../../../../../lib/studio/test-fakes";
import { createMcpSchemaPinsHandler } from "./route";

/**
 * Route tests for `PUT /api/studio/mcp-connections/[id]/schemas`: pinning only
 * allowlisted tools and returning an approved connection to draft.
 */

const WORKSPACE = "ws_test";
const KEY = Buffer.alloc(32, 0x01).toString("base64");
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
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
    status: "approved",
    generation: 1,
    toolAllowlist: ["catalog.search"],
    schemaHashes: { "catalog.search": HASH },
    credentialEnvelope: null,
    createdBy: "actor_ops",
    approvedBy: "actor_ops",
    approvedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function fixture(
  input: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    env?: NodeJS.ProcessEnv;
    connections?: StudioMcpConnection[];
  } = {},
) {
  const fake = createFakeStudio({
    settings: { workspaceId: WORKSPACE, enabled: true },
    mcpConnections: input.connections ?? [connection()],
  });
  const deps: StudioRouteDeps = {
    sessionContext: fakeSessionContext(input.role ?? "admin", {
      workspaceId: WORKSPACE,
    }).port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  const handler = createMcpSchemaPinsHandler(deps);
  const put = (body: unknown) =>
    handler(
      new Request(
        `http://localhost/api/studio/mcp-connections/${CONNECTION_ID}/schemas`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ id: CONNECTION_ID }) },
    );
  return { put, fake };
}

describe("PUT /api/studio/mcp-connections/[id]/schemas", () => {
  it("pins advertised hashes and resets approval to draft", async () => {
    const { put, fake } = fixture();
    const response = await put({
      schemaHashes: { "catalog.search": OTHER_HASH },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaHashes: { "catalog.search": OTHER_HASH },
      status: "draft",
      generation: 2,
    });
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.connection.schemas_pinned",
    ]);
  });

  it("rejects foreign tool keys, invalid bodies, non-admins and unknown ids", async () => {
    const { put } = fixture();
    expect((await put({ schemaHashes: { "other.tool": HASH } })).status).toBe(
      400,
    );
    for (const body of [{}, { schemaHashes: { "catalog.search": "nope" } }]) {
      expect((await put(body)).status).toBe(400);
    }
    const operator = fixture({ role: "operator" });
    expect(
      (await operator.put({ schemaHashes: { "catalog.search": OTHER_HASH } }))
        .status,
    ).toBe(403);
    const missing = fixture({ connections: [] });
    expect(
      (await missing.put({ schemaHashes: { "catalog.search": OTHER_HASH } }))
        .status,
    ).toBe(404);
  });

  it("fails closed with 409 while the external flag or key is missing", async () => {
    const flagOff = fixture({
      env: {
        CONVERSATION_STUDIO_ENABLED: "true",
        STUDIO_EXTERNAL_MCP_ENABLED: "",
        STUDIO_MCP_ENCRYPTION_KEY: KEY,
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(
      (await flagOff.put({ schemaHashes: { "catalog.search": OTHER_HASH } }))
        .status,
    ).toBe(409);
    const noKey = fixture({
      env: {
        CONVERSATION_STUDIO_ENABLED: "true",
        STUDIO_EXTERNAL_MCP_ENABLED: "true",
        STUDIO_MCP_ENCRYPTION_KEY: "",
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(
      (await noKey.put({ schemaHashes: { "catalog.search": OTHER_HASH } }))
        .status,
    ).toBe(409);
  });
});
