import { describe, expect, it } from "vitest";

import type { StudioMcpConnection } from "@wukong/db";
import type {
  ExternalMcpTool,
  McpClient,
  McpClientDeps,
  McpToolListResult,
} from "@wukong/ai";

import type { StudioRouteDeps } from "../../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
} from "../../../../../../lib/studio/test-fakes";
import { createMcpProbeHandler } from "./route";

/**
 * Route tests for `POST /api/studio/mcp-connections/[id]/probe`.
 *
 * The transport is always injected: no test reaches the network. The response
 * carries tool names and hashes only, and the ledger/audit rows never contain
 * the endpoint or credential.
 */

const WORKSPACE = "ws_test";
const KEY = Buffer.alloc(32, 0x01).toString("base64");
const HASH = "a".repeat(64);
const ENDPOINT = "https://mcp.example.test/rpc";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_EXTERNAL_MCP_ENABLED: "true",
  STUDIO_MCP_ENCRYPTION_KEY: KEY,
} as unknown as NodeJS.ProcessEnv;

function advertisedTool(name: string, hash: string): ExternalMcpTool {
  return {
    name,
    description: null,
    inputSchema: { type: "object" },
    schemaHash: hash,
  };
}

function connection(
  overrides: Partial<StudioMcpConnection> = {},
): StudioMcpConnection {
  const createdAt = new Date("2026-11-08T10:00:00.000Z");
  return {
    id: CONNECTION_ID,
    workspaceId: WORKSPACE,
    label: "External catalogue",
    endpointUrl: ENDPOINT,
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
    connections?: StudioMcpConnection[];
    tools?: McpToolListResult;
    capture?: { input?: McpClientDeps };
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
    createClient: (clientDeps: McpClientDeps): McpClient => {
      if (input.capture) input.capture.input = clientDeps;
      const result: McpToolListResult = input.tools ?? {
        status: "ok",
        tools: [advertisedTool("catalog.search", HASH)],
      };
      return {
        listTools: async () => result,
        callTool: async () => ({ status: "unavailable" }),
      };
    },
  };
  const handler = createMcpProbeHandler(deps);
  const probe = () =>
    handler(
      new Request(
        `http://localhost/api/studio/mcp-connections/${CONNECTION_ID}/probe`,
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: CONNECTION_ID }) },
    );
  return { probe, fake };
}

describe("POST /api/studio/mcp-connections/[id]/probe", () => {
  it("probes a draft, reports tool hashes and records a digest-only ledger row", async () => {
    const capture: { input?: McpClientDeps } = {};
    const { probe, fake } = fixture({ capture });
    const response = await probe();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      tools: Array<Record<string, unknown>>;
      missingPins: string[];
    };
    expect(body.status).toBe("ok");
    expect(body.tools).toEqual([
      {
        name: "catalog.search",
        allowlisted: true,
        advertisedHash: HASH,
        pinnedHash: HASH,
        match: true,
      },
    ]);
    expect(body.missingPins).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(ENDPOINT);
    expect(capture.input).toMatchObject({
      endpointUrl: ENDPOINT,
      toolAllowlist: ["catalog.search"],
      credential: null,
      enabled: true,
    });
    expect(fake.state.mcpCalls[0]).toMatchObject({
      connectionId: CONNECTION_ID,
      toolName: "tools/list",
      status: "ok",
      caller: "external_mcp",
    });
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.connection.probed",
    ]);
    expect(JSON.stringify(fake.state.audits)).not.toContain(ENDPOINT);
  });

  it("returns schema_drift without calling a tool", async () => {
    const { probe } = fixture({
      tools: {
        status: "ok",
        tools: [advertisedTool("catalog.search", "b".repeat(64))],
      },
    });
    const response = await probe();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "schema_drift",
      drift: ["catalog.search"],
    });
  });

  it("fails closed for disabled connections, missing gates, non-admins and unknown ids", async () => {
    const disabled = fixture({
      connections: [connection({ status: "disabled" })],
    });
    expect((await disabled.probe()).status).toBe(409);

    const flagOff = fixture({
      env: {
        CONVERSATION_STUDIO_ENABLED: "true",
        STUDIO_EXTERNAL_MCP_ENABLED: "",
        STUDIO_MCP_ENCRYPTION_KEY: KEY,
      } as unknown as NodeJS.ProcessEnv,
    });
    expect((await flagOff.probe()).status).toBe(409);

    const operator = fixture({ role: "operator" });
    expect((await operator.probe()).status).toBe(403);

    const missing = fixture({ connections: [] });
    expect((await missing.probe()).status).toBe(404);
  });

  it("reports a transport timeout honestly", async () => {
    const { probe, fake } = fixture({ tools: { status: "timeout" } });
    const response = await probe();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "timeout",
      tools: [],
    });
    expect(fake.state.mcpCalls[0]).toMatchObject({
      status: "unavailable",
      errorCode: "timeout",
    });
  });
});
