import { describe, expect, it, vi } from "vitest";

import {
  approvedEndpoint,
  canonicalJson,
  createMcpClient,
  schemaHash,
} from "./mcp-client.js";

/**
 * External MCP client tests (plan Task 13, spec §3.8).
 *
 * The injected fetch is the only transport: every "disabled/denied" case
 * asserts the fake was called zero times, and no live endpoint or credential
 * appears anywhere in this file.
 */

const ENDPOINT = "https://mcp.example.test/rpc";
const SCHEMA = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
};
const PINNED = schemaHash(SCHEMA);

type RecordedCall = { url: string; init: RequestInit };

function fakeTransport(
  responses: Array<() => Response | Promise<Response> | never>,
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra transport call");
    return next();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function jsonRpc(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function client(
  transport: ReturnType<typeof fakeTransport>,
  overrides: Partial<Parameters<typeof createMcpClient>[0]> = {},
) {
  return createMcpClient({
    endpointUrl: ENDPOINT,
    toolAllowlist: ["catalog.search"],
    schemaHashes: { "catalog.search": PINNED },
    enabled: true,
    fetch: transport.fetch,
    ...overrides,
  });
}

describe("external MCP client gating", () => {
  it("never calls the transport while disabled", async () => {
    const transport = fakeTransport([]);
    const mcp = client(transport, { enabled: false });
    await expect(mcp.listTools()).resolves.toEqual({ status: "unavailable" });
    await expect(mcp.callTool("catalog.search", {})).resolves.toEqual({
      status: "unavailable",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects non-https endpoints, credentials in the URL and malformed URLs", () => {
    expect(approvedEndpoint("http://mcp.example.test/rpc")).toBeNull();
    expect(
      approvedEndpoint("https://user:pass@mcp.example.test/rpc"),
    ).toBeNull();
    expect(approvedEndpoint("https://user@mcp.example.test/rpc")).toBeNull();
    expect(approvedEndpoint("not a url")).toBeNull();
    expect(approvedEndpoint(ENDPOINT)).not.toBeNull();
  });

  it("does not call the transport for a non-https or credential-bearing endpoint", async () => {
    for (const endpointUrl of [
      "http://mcp.example.test/rpc",
      "https://user:pass@mcp.example.test/rpc",
    ]) {
      const transport = fakeTransport([]);
      const mcp = client(transport, { endpointUrl });
      await expect(mcp.callTool("catalog.search", {})).resolves.toEqual({
        status: "unavailable",
      });
      expect(transport.calls).toHaveLength(0);
    }
  });

  it("denies tools outside the allowlist and tools without a pinned schema hash", async () => {
    const transport = fakeTransport([]);
    const mcp = client(transport);
    await expect(mcp.callTool("sql.query", {})).resolves.toEqual({
      status: "denied",
    });
    await expect(mcp.callTool("not.allowlisted", {})).resolves.toEqual({
      status: "denied",
    });
    expect(transport.calls).toHaveLength(0);

    const noPin = client(fakeTransport([]), { schemaHashes: {} });
    await expect(noPin.callTool("catalog.search", {})).resolves.toEqual({
      status: "denied",
    });
  });
});

describe("external MCP client operations", () => {
  it("lists advertised tools with canonical schema hashes", async () => {
    const transport = fakeTransport([
      () => jsonRpc({ protocolVersion: "2026-07-28", capabilities: {} }),
      () =>
        jsonRpc({
          tools: [
            {
              name: "catalog.search",
              description: "Search the catalog",
              inputSchema: SCHEMA,
            },
          ],
        }),
    ]);
    const listed = await client(transport).listTools();
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") throw new Error("unreachable");
    expect(listed.tools).toEqual([
      {
        name: "catalog.search",
        description: "Search the catalog",
        inputSchema: SCHEMA,
        schemaHash: PINNED,
      },
    ]);
    expect(transport.calls).toHaveLength(2);
    const first = transport.calls[0]!;
    expect(first.url).toBe(ENDPOINT);
    expect(first.init.redirect).toBe("error");
    expect(JSON.parse(String(first.init.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2026-07-28" },
    });
  });

  it("calls an allowlisted tool with a matching pinned schema and projects the output", async () => {
    const transport = fakeTransport([
      () => jsonRpc({ protocolVersion: "2026-07-28", capabilities: {} }),
      () =>
        jsonRpc({ tools: [{ name: "catalog.search", inputSchema: SCHEMA }] }),
      () =>
        jsonRpc({
          content: [
            {
              type: "text",
              text: JSON.stringify({ items: [{ listingId: "listing-1" }] }),
              annotations: { shouldNotLeak: true },
            },
          ],
          structuredContent: { shouldNotLeak: true },
          isError: false,
        }),
    ]);
    const mcp = client(transport, { credential: "secret-credential" });
    const called = await mcp.callTool("catalog.search", { query: "margaux" });
    expect(called).toEqual({
      status: "ok",
      output: { items: [{ listingId: "listing-1" }] },
    });
    expect(transport.calls).toHaveLength(3);
    const headers = transport.calls[2]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-credential");
    expect(JSON.parse(String(transport.calls[2]!.init.body))).toMatchObject({
      method: "tools/call",
      params: { name: "catalog.search", arguments: { query: "margaux" } },
    });
    // Projection keeps only parsed content text; provider extras are dropped.
    expect(JSON.stringify(called)).not.toContain("shouldNotLeak");
  });

  it("fails closed with schema_drift before any tool call when the advertised schema changed", async () => {
    const drifted = { ...SCHEMA, required: ["query", "locale"] };
    const transport = fakeTransport([
      () => jsonRpc({ protocolVersion: "2026-07-28", capabilities: {} }),
      () =>
        jsonRpc({ tools: [{ name: "catalog.search", inputSchema: drifted }] }),
    ]);
    const mcp = client(transport);
    await expect(mcp.callTool("catalog.search", {})).resolves.toEqual({
      status: "schema_drift",
    });
    expect(transport.calls).toHaveLength(2);
  });

  it("denies a tool that the server stopped advertising", async () => {
    const transport = fakeTransport([
      () => jsonRpc({ protocolVersion: "2026-07-28", capabilities: {} }),
      () => jsonRpc({ tools: [] }),
    ]);
    await expect(
      client(transport).callTool("catalog.search", {}),
    ).resolves.toEqual({ status: "denied" });
    expect(transport.calls).toHaveLength(2);
  });

  it("maps provider errors, invalid envelopes and oversize bodies to unavailable", async () => {
    const cases: Array<() => Response> = [
      () => new Response("denied", { status: 500 }),
      () => new Response("not-json", { status: 200 }),
      () => jsonRpc("not-an-object"),
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32603, message: "boom" },
          }),
          { status: 200 },
        ),
    ];
    for (const response of cases) {
      const transport = fakeTransport([response, response]);
      const listed = await client(transport).listTools();
      expect(listed.status).toBe("unavailable");
    }

    const oversize = fakeTransport([
      () => new Response("x".repeat(70_000), { status: 200 }),
    ]);
    await expect(client(oversize).listTools()).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("maps an isError tool result to unavailable without returning output", async () => {
    const transport = fakeTransport([
      () => jsonRpc({ protocolVersion: "2026-07-28", capabilities: {} }),
      () =>
        jsonRpc({ tools: [{ name: "catalog.search", inputSchema: SCHEMA }] }),
      () =>
        jsonRpc({
          content: [{ type: "text", text: '{"error":"invalid_arguments"}' }],
          isError: true,
        }),
    ]);
    await expect(
      client(transport).callTool("catalog.search", {}),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("maps aborts and deadline expiry to timeout", async () => {
    const aborted = fakeTransport([
      () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    ]);
    await expect(
      client(aborted, { deadlineMs: 50 }).listTools(),
    ).resolves.toEqual({ status: "timeout" });

    const hanging = fakeTransport([() => new Promise<never>(() => undefined)]);
    await expect(
      client(hanging, { deadlineMs: 5 }).listTools(),
    ).resolves.toEqual({ status: "timeout" });
  });

  it("never retries a failed request", async () => {
    const transport = fakeTransport([
      () => new Response("nope", { status: 502 }),
    ]);
    await client(transport).listTools();
    expect(transport.calls).toHaveLength(1);
  });
});

describe("mcp client canonical hashing", () => {
  it("sorts keys at every depth so hashes are stable", () => {
    const left = { b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } };
    const right = { a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(schemaHash(left)).toBe(schemaHash(right));
  });

  it("changes the hash when a required field changes", () => {
    expect(schemaHash(SCHEMA)).not.toBe(
      schemaHash({ ...SCHEMA, required: ["query", "locale"] }),
    );
  });

  it("does not log anything while running", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const transport = fakeTransport([
      () => jsonRpc({ protocolVersion: "2026-07-28", capabilities: {} }),
      () => jsonRpc({ tools: [] }),
    ]);
    await client(transport).listTools();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });
});
