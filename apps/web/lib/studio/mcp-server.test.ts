import { describe, expect, it } from "vitest";

import { isStudioMcpServerEnabled } from "../studio-flags";
import {
  createMcpServer,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  type McpServerDeps,
} from "./mcp-server.js";
import { hashMcpTokenSecret } from "./mcp-tokens.js";
import {
  answeredTurnOptions,
  createFakeStudio,
  fakeApiToken,
  fakeGetDatabase,
  type FakeStudioOptions,
} from "./test-fakes.js";

/**
 * Hosted-MCP protocol and authorization tests (plan Task 12).
 *
 * No network, no real provider and no database: the token row, the workspace
 * settings and the creator membership are fakes, while the JSON-RPC transport,
 * the tool allowlist and the ledger writes are the production code.
 */

const WORKSPACE = "ws_test";
const PREFIX = "abcdefghijkl";
const SECRET = "s".repeat(43);
const TOKEN = `wuk_${PREFIX}.${SECRET}`;
const TOKEN_HASH = hashMcpTokenSecret(SECRET);
const NOW_MS = Date.parse("2026-11-08T10:00:00.000Z");
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_MCP_SERVER_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

type MemberRole = "viewer" | "operator" | "reviewer" | "admin" | "owner";

function fixture(
  input: {
    scopes?: string[];
    role?: MemberRole;
    env?: NodeJS.ProcessEnv;
    options?: FakeStudioOptions;
    revokedAt?: Date | null;
    prefix?: string;
    deadlineMs?: number;
    now?: () => number;
    settingsEnabled?: boolean;
    rateLimitPerMinute?: number | null;
    monthlyCallQuota?: number | null;
    /** Ledger rows for this token, one second before NOW. */
    priorCalls?: number;
    /** Ledger rows for a different token in the same workspace. */
    priorForeignCalls?: number;
  } = {},
) {
  const token = fakeApiToken({
    workspaceId: WORKSPACE,
    prefix: input.prefix ?? PREFIX,
    scopes: input.scopes ?? ["read", "propose"],
    createdBy: "actor_ops",
    revokedAt: input.revokedAt ?? null,
    rateLimitPerMinute: input.rateLimitPerMinute ?? null,
    monthlyCallQuota: input.monthlyCallQuota ?? null,
  });
  const options = input.options ?? {};
  const ledgerRow = (
    tokenId: string,
    index: number,
  ): NonNullable<FakeStudioOptions["mcpCalls"]>[number] => ({
    id: `00000000-0000-4000-8000-${String(900000 + index).padStart(12, "0")}`,
    workspaceId: WORKSPACE,
    runId: null,
    connectionId: null,
    tokenId,
    toolName: "catalog.search",
    requestDigest: "a".repeat(64),
    responseDigest: null,
    status: "ok",
    errorCode: null,
    latencyMs: 5,
    caller: "external_mcp",
    createdAt: new Date(NOW_MS - 1_000),
  });
  const priorLedger = [
    ...Array.from({ length: input.priorCalls ?? 0 }, (_, index) =>
      ledgerRow(token.id, index),
    ),
    ...Array.from({ length: input.priorForeignCalls ?? 0 }, (_, index) =>
      ledgerRow(
        `00000000-0000-4000-8000-${String(800000 + index).padStart(12, "0")}`,
        index,
      ),
    ),
  ];
  const fake = createFakeStudio({
    ...options,
    settings: {
      workspaceId: WORKSPACE,
      enabled: input.settingsEnabled ?? true,
      ...(options.settings ?? {}),
    },
    memberships: [{ userId: "actor_ops", role: input.role ?? "admin" }],
    apiTokens: [token, ...(options.apiTokens ?? [])],
    mcpCalls: [...priorLedger, ...(options.mcpCalls ?? [])],
  });
  const deps: McpServerDeps = {
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls, [
      { hash: TOKEN_HASH, token },
    ]),
    isMcpServerEnabled: isStudioMcpServerEnabled,
    env: input.env ?? ON_ENV,
    now: input.now ?? (() => NOW_MS),
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
  };
  return { server: createMcpServer(deps), fake, token };
}

function request(
  body: unknown,
  options: {
    token?: string | null;
    method?: string;
    authorization?: string;
  } = {},
): Request {
  const method = options.method ?? "POST";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  } else if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  }
  const init: RequestInit = { method, headers };
  if (method !== "GET" && body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("http://localhost/api/mcp", init);
}

function rpc(id: string | number | null, method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

async function call(
  server: ReturnType<typeof createMcpServer>,
  body: unknown,
  options?: Parameters<typeof request>[1],
) {
  const response = await server.handle(request(body, options));
  const text = await response.text();
  return {
    response,
    body:
      text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

function errorCode(body: Record<string, unknown> | null): unknown {
  return (body?.error as { code?: unknown } | undefined)?.code;
}

describe("MCP transport gates", () => {
  it("answers GET with 405 and Allow: POST", async () => {
    const { server } = fixture();
    const { response } = await call(server, undefined, { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns 404 before token resolution when the MCP flag is off", async () => {
    const server = createMcpServer({
      getDatabase: () => {
        throw new Error("must stay lazy");
      },
      isMcpServerEnabled: isStudioMcpServerEnabled,
      env: {
        CONVERSATION_STUDIO_ENABLED: "true",
      } as unknown as NodeJS.ProcessEnv,
    });
    const { response } = await call(server, rpc(1, "ping"));
    expect(response.status).toBe(404);
  });

  it("rejects missing, malformed, prefix-mismatched, revoked and foreign tokens with 401", async () => {
    const missing = await call(fixture().server, rpc(1, "ping"), {
      token: null,
    });
    expect(missing.response.status).toBe(401);

    const malformed = await call(fixture().server, rpc(1, "ping"), {
      authorization: "Bearer not-a-wukong-token",
    });
    expect(malformed.response.status).toBe(401);

    const prefixMismatch = await call(fixture().server, rpc(1, "ping"), {
      token: `wuk_wrongprefix.${SECRET}`,
    });
    expect(prefixMismatch.response.status).toBe(401);

    const revoked = await call(
      fixture({ revokedAt: new Date("2026-11-08T09:00:00.000Z") }).server,
      rpc(1, "ping"),
    );
    expect(revoked.response.status).toBe(401);

    const foreignSecret = "x".repeat(43);
    const foreign = await call(fixture().server, rpc(1, "ping"), {
      token: `wuk_foreign1234.${foreignSecret}`,
    });
    expect(foreign.response.status).toBe(401);
  });

  it("rejects a token whose creator is no longer a member", async () => {
    const token = fakeApiToken({
      workspaceId: WORKSPACE,
      prefix: PREFIX,
      createdBy: "actor_ops",
    });
    const fake = createFakeStudio({
      settings: { workspaceId: WORKSPACE, enabled: true },
      memberships: [],
      apiTokens: [token],
    });
    const server = createMcpServer({
      getDatabase: fakeGetDatabase(
        fake.repos,
        [],
        [{ hash: TOKEN_HASH, token }],
      ),
      isMcpServerEnabled: isStudioMcpServerEnabled,
      env: ON_ENV,
    });
    const { response } = await call(server, rpc(1, "ping"));
    expect(response.status).toBe(401);
  });

  it("returns 404 when the workspace row disables Studio", async () => {
    const { server } = fixture({ settingsEnabled: false });
    const { response } = await call(server, rpc(1, "ping"));
    expect(response.status).toBe(404);
  });

  it("returns 400 for malformed bodies and envelopes, 413 for oversized bodies", async () => {
    const { server } = fixture();
    const malformed = await call(server, "{not-json");
    expect(malformed.response.status).toBe(400);
    expect(errorCode(malformed.body)).toBe(-32600);

    const wrongVersion = await call(server, {
      jsonrpc: "1.0",
      id: 1,
      method: "ping",
    });
    expect(wrongVersion.response.status).toBe(400);
    expect(errorCode(wrongVersion.body)).toBe(-32600);

    const oversized = await call(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { pad: "x".repeat(70_000) },
    });
    expect(oversized.response.status).toBe(413);
  });

  it("returns a JSON-RPC internal error when the database is unavailable", async () => {
    const server = createMcpServer({
      getDatabase: () => {
        throw new Error("database down");
      },
      isMcpServerEnabled: isStudioMcpServerEnabled,
      env: ON_ENV,
    });
    const { response, body } = await call(server, rpc(9, "ping"), {
      token: TOKEN,
    });
    expect(response.status).toBe(500);
    expect(errorCode(body)).toBe(-32603);
  });
});

describe("MCP methods", () => {
  it("initializes with the implemented protocol version and rejects others", async () => {
    const { server } = fixture();
    const initialized = await call(
      server,
      rpc(1, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION }),
    );
    expect(initialized.response.status).toBe(200);
    expect(initialized.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME },
      },
    });

    const unsupported = await call(
      server,
      rpc(2, "initialize", { protocolVersion: "2024-01-01" }),
    );
    expect(errorCode(unsupported.body)).toBe(-32602);
  });

  it("handles notifications/initialized with 202 and no body", async () => {
    const { server } = fixture();
    const { response, body } = await call(server, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(body).toBeNull();
  });

  it("answers ping and unknown methods", async () => {
    const { server } = fixture();
    const ping = await call(server, rpc(3, "ping"));
    expect(ping.body).toMatchObject({ id: 3, result: {} });

    const unknown = await call(server, rpc(4, "resources/list"));
    expect(unknown.response.status).toBe(200);
    expect(errorCode(unknown.body)).toBe(-32601);
  });

  it("lists only read/propose tools within the token scopes and role floor", async () => {
    const both = fixture();
    const listed = await call(both.server, rpc(1, "tools/list"));
    const tools = (
      listed.body?.result as {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: unknown;
        }>;
      }
    ).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "catalog.search",
        "catalog.get",
        "quality.get_gaps",
        "imports.list",
        "exports.get",
        "jobs.list",
        "assets.list",
        "listing.get_run_status",
        "listing.propose_copy",
      ]),
    );
    expect(names).not.toContain("listing.create_draft");
    for (const tool of tools) {
      expect(tool.description).toContain("never");
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }

    const readOnly = fixture({ scopes: ["read"] });
    const readListed = await call(readOnly.server, rpc(1, "tools/list"));
    const readNames = (
      readListed.body?.result as { tools: Array<{ name: string }> }
    ).tools.map((tool) => tool.name);
    expect(readNames).toContain("catalog.search");
    expect(readNames).not.toContain("listing.propose_copy");
    expect(readNames).not.toContain("listing.create_draft");

    const viewer = fixture({ role: "viewer" });
    const viewerListed = await call(viewer.server, rpc(1, "tools/list"));
    expect((viewerListed.body?.result as { tools: unknown[] }).tools).toEqual(
      [],
    );
  });

  it("executes an allowed read tool, records the ledger and audit, and touches the token", async () => {
    const { server, fake, token } = fixture({
      options: answeredTurnOptions(),
    });
    const called = await call(
      server,
      rpc(7, "tools/call", {
        name: "catalog.search",
        arguments: { query: "margaux" },
      }),
    );
    expect(called.response.status).toBe(200);
    const result = called.body?.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      items: [
        {
          listingId: "listing-1",
          title: "Margaux 2019",
          status: "in_review",
        },
      ],
      truncated: false,
    });

    const ledger = fake.state.mcpCalls[0]!;
    expect(ledger).toMatchObject({
      toolName: "catalog.search",
      status: "ok",
      caller: "external_mcp",
      errorCode: null,
    });
    expect(ledger.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(ledger.responseDigest).toMatch(/^[a-f0-9]{64}$/);

    const audit = fake.state.audits.find(
      (event) => event.action === "studio.mcp.call",
    );
    expect(audit?.metadata).toMatchObject({
      tool: "catalog.search",
      outcome: "ok",
    });
    expect(audit?.metadata.argumentsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(audit?.entityId).toBe(token.id);
    expect(fake.state.apiTokens[0]?.lastUsedAt).not.toBeNull();
  });

  it("reports an unavailable tool result honestly", async () => {
    const { server, fake } = fixture({ options: answeredTurnOptions() });
    const called = await call(
      server,
      rpc(8, "tools/call", {
        name: "catalog.get",
        arguments: { listingId: "unknown-listing" },
      }),
    );
    const result = called.body?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(fake.state.mcpCalls[0]?.status).toBe("unavailable");
  });

  it("executes imports.list and exports.get read tools", async () => {
    const at = new Date("2026-11-08T10:00:00.000Z");
    const { server } = fixture({
      options: {
        ...answeredTurnOptions(),
        sourceImports: [{ id: "import-1", createdAt: at }],
        exportAttempts: [
          {
            id: "attempt-1",
            artifactStatus: "ready",
            rowCount: 2,
            createdAt: at,
          },
        ],
      },
    });
    const readImports = await call(
      server,
      rpc(20, "tools/call", {
        name: "imports.list",
        arguments: { limit: 5 },
      }),
    );
    const importsResult = readImports.body?.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(importsResult.isError).toBeUndefined();
    expect(JSON.parse(importsResult.content[0]!.text)).toEqual({
      items: [
        {
          importId: "import-1",
          state: "received",
          receivedAt: at.toISOString(),
        },
      ],
      truncated: false,
    });

    const readExport = await call(
      server,
      rpc(21, "tools/call", {
        name: "exports.get",
        arguments: { exportAttemptId: "attempt-1" },
      }),
    );
    const exportResult = readExport.body?.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(exportResult.isError).toBeUndefined();
    expect(JSON.parse(exportResult.content[0]!.text)).toEqual({
      exportAttemptId: "attempt-1",
      state: "ready",
      reconciliation: "unknown",
    });

    const missing = await call(
      server,
      rpc(22, "tools/call", {
        name: "exports.get",
        arguments: { exportAttemptId: "attempt-foreign" },
      }),
    );
    expect((missing.body?.result as { isError?: boolean }).isError).toBe(true);
  });

  it("returns isError for invalid arguments and records schema_drift", async () => {
    const { server, fake } = fixture({ options: answeredTurnOptions() });
    const called = await call(
      server,
      rpc(9, "tools/call", {
        name: "catalog.get",
        arguments: { listingId: 42 },
      }),
    );
    expect(called.response.status).toBe(200);
    expect((called.body?.result as { isError?: boolean }).isError).toBe(true);
    const ledger = fake.state.mcpCalls[0]!;
    expect(ledger.status).toBe("schema_drift");
    expect(ledger.errorCode).toBe("invalid_arguments");
  });

  it("rejects dispatch, unknown, out-of-scope and role-blocked tools", async () => {
    const dispatch = await call(
      fixture().server,
      rpc(10, "tools/call", {
        name: "listing.create_draft",
        arguments: { assetIds: ["asset-1"], confirmed: true },
      }),
    );
    expect(errorCode(dispatch.body)).toBe(-32602);
    expect(dispatch.body?.error).toMatchObject({
      message: "Tool is not available.",
    });

    const unknown = await call(
      fixture().server,
      rpc(11, "tools/call", { name: "sql.query", arguments: {} }),
    );
    expect(errorCode(unknown.body)).toBe(-32602);
    expect(unknown.body?.error).toMatchObject({ message: "Unknown tool." });

    const outOfScopeFixture = fixture({ scopes: ["read"] });
    const outOfScope = await call(
      outOfScopeFixture.server,
      rpc(12, "tools/call", {
        name: "listing.propose_copy",
        arguments: {
          listingId: "listing-1",
          activeVersionId: "version-1",
          fields: [
            {
              field: "title.en",
              current: null,
              proposed: "New title",
              evidenceRefs: ["catalog:listing-1"],
            },
          ],
        },
      }),
    );
    expect(errorCode(outOfScope.body)).toBe(-32602);
    expect(outOfScopeFixture.fake.state.mcpCalls[0]?.status).toBe("denied");

    const viewerFixture = fixture({ role: "viewer" });
    const viewerBlocked = await call(
      viewerFixture.server,
      rpc(13, "tools/call", {
        name: "catalog.search",
        arguments: { query: "margaux" },
      }),
    );
    expect(errorCode(viewerBlocked.body)).toBe(-32602);
    expect(viewerFixture.fake.state.mcpCalls[0]?.status).toBe("denied");
  });

  it("enforces the tool deadline and records an error ledger row", async () => {
    let tick = 0;
    const { server, fake } = fixture({
      options: answeredTurnOptions(),
      deadlineMs: 1,
      now: () => {
        tick += 10_000;
        return NOW_MS + tick;
      },
    });
    const called = await call(
      server,
      rpc(14, "tools/call", {
        name: "catalog.get",
        arguments: { listingId: "listing-1" },
      }),
    );
    expect(errorCode(called.body)).toBe(-32002);
    const ledger = fake.state.mcpCalls[0]!;
    expect(ledger.status).toBe("error");
    expect(ledger.errorCode).toBe("deadline_exceeded");
  });

  it("attributes recorded ledger rows to the calling token", async () => {
    const { server, fake, token } = fixture({ options: answeredTurnOptions() });
    const called = await call(
      server,
      rpc(15, "tools/call", {
        name: "catalog.search",
        arguments: { query: "margaux" },
      }),
    );
    expect(called.response.status).toBe(200);
    expect(fake.state.mcpCalls[0]?.tokenId).toBe(token.id);
  });

  it("rejects a call over the rolling-minute limit without executing or recording", async () => {
    const { server, fake } = fixture({
      options: answeredTurnOptions(),
      rateLimitPerMinute: 1,
      priorCalls: 1,
    });
    const called = await call(
      server,
      rpc(16, "tools/call", {
        name: "catalog.search",
        arguments: { query: "margaux" },
      }),
    );
    expect(called.response.status).toBe(200);
    expect(errorCode(called.body)).toBe(-32029);
    expect(fake.state.mcpCalls).toHaveLength(1);
    expect(fake.state.audits).toHaveLength(0);
    expect(fake.state.mcpCalls[0]?.tokenId).not.toBeNull();
  });

  it("rejects a call over the UTC-month quota without executing or recording", async () => {
    const { server, fake } = fixture({
      options: answeredTurnOptions(),
      monthlyCallQuota: 2,
      priorCalls: 2,
    });
    const called = await call(
      server,
      rpc(17, "tools/call", {
        name: "catalog.search",
        arguments: { query: "margaux" },
      }),
    );
    expect(called.response.status).toBe(200);
    expect(errorCode(called.body)).toBe(-32030);
    expect(fake.state.mcpCalls).toHaveLength(2);
    expect(fake.state.audits).toHaveLength(0);
  });

  it("executes under the configured quotas and counts are per token", async () => {
    const { server, fake } = fixture({
      options: answeredTurnOptions(),
      rateLimitPerMinute: 1,
      monthlyCallQuota: 10,
      priorCalls: 0,
      priorForeignCalls: 50,
    });
    const called = await call(
      server,
      rpc(18, "tools/call", {
        name: "catalog.search",
        arguments: { query: "margaux" },
      }),
    );
    expect(called.response.status).toBe(200);
    expect(called.body?.error).toBeUndefined();
    // The tool result plus its ledger/audit: quota counts for another token
    // never block this one.
    expect(fake.state.mcpCalls).toHaveLength(51);
    expect(fake.state.mcpCalls.at(-1)?.status).toBe("ok");
    expect(fake.state.audits).toHaveLength(1);
  });

  it("keeps scope enforcement independent of quotas", async () => {
    // A read-scope token cannot call a propose tool.
    const readOnly = fixture({ scopes: ["read"] });
    const proposeDenied = await call(
      readOnly.server,
      rpc(19, "tools/call", {
        name: "listing.copy_proposal",
        arguments: { listingId: "listing-1" },
      }),
    );
    expect(errorCode(proposeDenied.body)).toBe(-32602);

    // A propose-scope token cannot reach dispatch/write tools either.
    const proposeOnly = fixture({ scopes: ["propose"] });
    for (const name of ["listing.dispatch", "listing.approve"]) {
      const denied = await call(
        proposeOnly.server,
        rpc(20, "tools/call", { name, arguments: {} }),
      );
      expect(
        errorCode(denied.body),
        `${name} must not be callable over MCP`,
      ).toBe(-32602);
    }
    const toolsList = await call(proposeOnly.server, rpc(21, "tools/list"));
    const tools =
      (
        (toolsList.body ?? {}) as {
          result?: { tools?: { name: string }[] };
        }
      ).result?.tools ?? [];
    expect(
      tools.every((tool) => !tool.name.startsWith("listing.dispatch")),
    ).toBe(true);
  });
});
