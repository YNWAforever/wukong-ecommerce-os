import { describe, expect, it } from "vitest";

import type { StudioMcpConnection } from "@wukong/db";

import type { StudioRouteDeps } from "../../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
} from "../../../../../../lib/studio/test-fakes";
import { createMcpCredentialHandler } from "./route";

/**
 * Route tests for `PUT|DELETE /api/studio/mcp-connections/[id]/credential`.
 *
 * Plaintext exists only in the request body; the response and every audit row
 * are asserted free of it.
 */

const WORKSPACE = "ws_test";
const KEY = Buffer.alloc(32, 0x01).toString("base64");
const HASH = "a".repeat(64);
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL = "synthetic-bearer-secret";
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
  const handler = createMcpCredentialHandler(deps);
  const call = (method: "PUT" | "DELETE", body?: unknown) =>
    handler[method](
      new Request(
        `http://localhost/api/studio/mcp-connections/${CONNECTION_ID}/credential`,
        {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
      { params: Promise.resolve({ id: CONNECTION_ID }) },
    );
  return {
    fake,
    put: (body: unknown) => call("PUT", body),
    del: () => call("DELETE"),
  };
}

describe("PUT|DELETE /api/studio/mcp-connections/[id]/credential", () => {
  it("stores the credential without returning it and resets approval", async () => {
    const { put, fake } = fixture();
    const response = await put({ credential: CREDENTIAL });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      credentialPresent: boolean;
      status: string;
      generation: number;
    };
    expect(body).toMatchObject({
      credentialPresent: true,
      status: "draft",
      generation: 2,
    });
    expect(JSON.stringify(body)).not.toContain(CREDENTIAL);
    expect(fake.state.mcpConnections[0]!.credentialEnvelope).toMatch(/^v1\./);
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.connection.credential_set",
    ]);
    expect(JSON.stringify(fake.state.audits)).not.toContain(CREDENTIAL);
  });

  it("clears the credential and reports absence", async () => {
    const { del } = fixture({
      connections: [connection({ credentialEnvelope: "v1.iv.ciphertext" })],
    });
    const response = await del();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      credentialPresent: false,
      generation: 2,
    });
  });

  it("fails closed with 409 while the external flag or key is missing", async () => {
    for (const env of [
      {
        CONVERSATION_STUDIO_ENABLED: "true",
        STUDIO_EXTERNAL_MCP_ENABLED: "",
        STUDIO_MCP_ENCRYPTION_KEY: KEY,
      } as unknown as NodeJS.ProcessEnv,
      {
        CONVERSATION_STUDIO_ENABLED: "true",
        STUDIO_EXTERNAL_MCP_ENABLED: "true",
        STUDIO_MCP_ENCRYPTION_KEY: "",
      } as unknown as NodeJS.ProcessEnv,
    ]) {
      const { put } = fixture({ env });
      expect((await put({ credential: CREDENTIAL })).status).toBe(409);
    }
  });

  it("rejects invalid bodies, non-admins and unknown ids", async () => {
    const { put } = fixture();
    for (const body of [
      {},
      { credential: "" },
      { credential: "x", extra: 1 },
    ]) {
      expect((await put(body)).status).toBe(400);
    }
    const operator = fixture({ role: "operator" });
    expect((await operator.put({ credential: CREDENTIAL })).status).toBe(403);
    const missing = fixture({ connections: [] });
    expect((await missing.put({ credential: CREDENTIAL })).status).toBe(404);
  });
});
