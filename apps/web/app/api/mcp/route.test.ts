import { describe, expect, it } from "vitest";

import type { StudioMcpCall } from "@wukong/db";

import { isStudioMcpServerEnabled } from "../../../lib/studio-flags";
import {
  createFakeStudio,
  fakeApiToken,
  fakeGetDatabase,
} from "../../../lib/studio/test-fakes";
import { hashMcpTokenSecret } from "../../../lib/studio/mcp-tokens";
import { createMcpHandlers } from "./route";

/**
 * Route-contract tests for the hosted MCP endpoint binding (plan Task 12):
 * GET 405, flag-off 404, bearer 401 and a real initialize handshake through
 * the Next.js handler shape.
 */

const WORKSPACE = "ws_test";
const PREFIX = "abcdefghijkl";
const SECRET = "s".repeat(43);
const TOKEN = `wuk_${PREFIX}.${SECRET}`;
const TOKEN_HASH = hashMcpTokenSecret(SECRET);
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_MCP_SERVER_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

function fixture(env: NodeJS.ProcessEnv = ON_ENV) {
  const token = fakeApiToken({ workspaceId: WORKSPACE, prefix: PREFIX });
  const fake = createFakeStudio({
    settings: { workspaceId: WORKSPACE, enabled: true },
    apiTokens: [token],
  });
  const handlers = createMcpHandlers({
    getDatabase: fakeGetDatabase(fake.repos, [], [{ hash: TOKEN_HASH, token }]),
    isMcpServerEnabled: isStudioMcpServerEnabled,
    env,
  });
  return { handlers, fake };
}

function rpcRequest(
  body: unknown,
  options: { token?: string | null; method?: string } = {},
): Request {
  const method = options.method ?? "POST";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  }
  return new Request("http://localhost/api/mcp", {
    method,
    headers,
    ...(method === "GET" || body === undefined
      ? {}
      : { body: JSON.stringify(body) }),
  });
}

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("POST /api/mcp", () => {
  it("runs the initialize handshake with a valid token", async () => {
    const { handlers } = fixture();
    const response = await handlers.POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2026-07-28" },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.result.protocolVersion).toBe("2026-07-28");
    expect(body.result.serverInfo.name).toBe("wukong-eommerce-studio");
  });

  it("rejects GET with 405", async () => {
    const { handlers } = fixture();
    const response = await handlers.GET(
      rpcRequest(undefined, { method: "GET" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns 404 when disabled, 401 without a bearer token and 400 for malformed JSON", async () => {
    const disabled = fixture({} as NodeJS.ProcessEnv);
    expect((await disabled.handlers.POST(rpcRequest(ping))).status).toBe(404);

    const { handlers } = fixture();
    expect(
      (await handlers.POST(rpcRequest(ping, { token: null }))).status,
    ).toBe(401);

    const malformed = await handlers.POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "{not-json",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: -32600 } });
  });

  it("returns the JSON-RPC quota envelope with HTTP 200 from the route", async () => {
    const token = fakeApiToken({
      workspaceId: WORKSPACE,
      prefix: PREFIX,
      rateLimitPerMinute: 1,
    });
    const priorCall: StudioMcpCall = {
      id: "00000000-0000-4000-8000-000000000901",
      workspaceId: WORKSPACE,
      runId: null,
      connectionId: null,
      tokenId: token.id,
      toolName: "catalog.search",
      requestDigest: "a".repeat(64),
      responseDigest: null,
      status: "ok",
      errorCode: null,
      latencyMs: 3,
      caller: "external_mcp",
      createdAt: new Date(),
    };
    const fake = createFakeStudio({
      settings: { workspaceId: WORKSPACE, enabled: true },
      apiTokens: [token],
      mcpCalls: [priorCall],
    });
    const handlers = createMcpHandlers({
      getDatabase: fakeGetDatabase(
        fake.repos,
        [],
        [{ hash: TOKEN_HASH, token }],
      ),
      isMcpServerEnabled: isStudioMcpServerEnabled,
      env: ON_ENV,
    });
    const response = await handlers.POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "catalog.search", arguments: { query: "margaux" } },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32029 },
    });
    expect(fake.state.mcpCalls).toHaveLength(1);
  });
});
