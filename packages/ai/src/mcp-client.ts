import { createHash } from "node:crypto";

/**
 * Outbound client for admin-approved external MCP servers (plan Task 13, spec
 * §3.8).
 *
 * External connections are disabled by default. The caller computes an
 * `enabled` gate (global flag + workspace Studio + connection approved) and
 * passes it here; every public method returns a typed "unavailable" without a
 * single fetch when it is false. Even when enabled, the client:
 *
 *  - accepts only an `https:` endpoint without embedded credentials;
 *  - sets `redirect: "error"` so a redirect fails closed instead of being
 *    followed to an unapproved origin;
 *  - enforces the tool allowlist plus the schema hash pinned at activation;
 *  - caps the response at 64 KiB, applies a 12 s deadline and never retries;
 *  - projects only `content[].text` from a tool result and drops every other
 *    field, so raw provider payloads are not retained;
 *  - never logs the endpoint query string, credential or payload.
 */

export const MCP_CLIENT_PROTOCOL_VERSION = "2026-07-28";
export const MCP_CLIENT_DEADLINE_MS = 12_000;
export const MCP_CLIENT_MAX_RESPONSE_BYTES = 64 * 1024;

const MAX_ADVERTISED_TOOLS = 50;
const MAX_CONTENT_ITEMS = 10;
const MAX_TEXT_CHARS = 16_000;
const MAX_PROJECTED_BYTES = 32 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type McpClientStatus =
  "ok" | "unavailable" | "schema_drift" | "denied" | "timeout";

export type ExternalMcpTool = {
  name: string;
  description: string | null;
  inputSchema: unknown;
  /** sha256 of the canonical input schema, pinned at activation. */
  schemaHash: string;
};

export type McpToolListResult =
  | { status: "ok"; tools: ExternalMcpTool[] }
  | { status: Exclude<McpClientStatus, "ok"> };

export type McpToolCallResult =
  | { status: "ok"; output: unknown }
  | { status: Exclude<McpClientStatus, "ok"> };

export type McpClientDeps = {
  endpointUrl: string;
  /** Tool names the admin approved; anything else is denied before transport. */
  toolAllowlist: readonly string[];
  /**
   * Pinned `{ tool name -> sha256(inputSchema) }` snapshot from activation.
   * A call for a tool without a pinned hash is denied (fail closed), and a
   * live schema that no longer matches is `schema_drift` with no tool call.
   */
  schemaHashes?: Readonly<Record<string, string>>;
  /** Decrypted workspace credential; sent as a bearer header, never logged. */
  credential?: string | null;
  /** False disables every transport call (the shipped default). */
  enabled: boolean;
  fetch?: typeof fetch;
  deadlineMs?: number;
  maxResponseBytes?: number;
};

type RpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; status: Exclude<McpClientStatus, "ok"> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic JSON for schema hashing: keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function schemaHash(inputSchema: unknown): string {
  return createHash("sha256").update(canonicalJson(inputSchema)).digest("hex");
}

function ipv4Octets(hostname: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map((part) => Number(part));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function inIpv4Cidr(
  octets: number[],
  base: [number, number, number, number],
  bits: number,
): boolean {
  const value =
    ((octets[0]! << 24) >>> 0) +
    (octets[1]! << 16) +
    (octets[2]! << 8) +
    octets[3]!;
  const begin =
    ((base[0] << 24) >>> 0) + (base[1] << 16) + (base[2] << 8) + base[3];
  return value >= begin && value < begin + 2 ** (32 - bits);
}

/**
 * True for loopback, private, link-local, multicast and otherwise non-public
 * destinations. Hosted MCP calls are server-side, so an approved connection
 * must never be able to address the deployment's own network (SSRF guard).
 * DNS names are checked textually; DNS rebinding is a residual risk documented
 * in the Conversation Studio runbook rather than solved here.
 */
export function isPrivateEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    return isPrivateIpv6(host.slice(1, -1));
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const octets = ipv4Octets(host);
  if (!octets) return false;
  return (
    inIpv4Cidr(octets, [0, 0, 0, 0], 8) ||
    inIpv4Cidr(octets, [10, 0, 0, 0], 8) ||
    inIpv4Cidr(octets, [100, 64, 0, 0], 10) ||
    inIpv4Cidr(octets, [127, 0, 0, 0], 8) ||
    inIpv4Cidr(octets, [169, 254, 0, 0], 16) ||
    inIpv4Cidr(octets, [172, 16, 0, 0], 12) ||
    inIpv4Cidr(octets, [192, 0, 0, 0], 24) ||
    inIpv4Cidr(octets, [192, 168, 0, 0], 16) ||
    inIpv4Cidr(octets, [198, 18, 0, 0], 15) ||
    inIpv4Cidr(octets, [224, 0, 0, 0], 4) ||
    inIpv4Cidr(octets, [240, 0, 0, 0], 4)
  );
}

function isPrivateIpv6(address: string): boolean {
  const host = address.toLowerCase();
  if (host === "::" || host === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (/^ff[0-9a-f]{2}:/.test(host)) return true;
  if (host.startsWith("::ffff:")) {
    const mapped = ipv4Octets(host.slice("::ffff:".length));
    return mapped !== null && isPrivateEndpointHost(mapped.join("."));
  }
  return false;
}

/** Validate the fixed origin: https, no embedded userinfo, public host only. */
export function approvedEndpoint(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (isPrivateEndpointHost(url.hostname)) return null;
  return url;
}

function projectToolResult(result: unknown): unknown {
  if (!isRecord(result)) return null;
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const entry of content.slice(0, MAX_CONTENT_ITEMS)) {
    if (!isRecord(entry)) continue;
    if (entry.type !== "text" || typeof entry.text !== "string") continue;
    texts.push(entry.text.slice(0, MAX_TEXT_CHARS));
  }
  if (texts.length === 0) return null;
  const joined = texts.join("\n");
  try {
    const parsed: unknown = JSON.parse(joined);
    if (JSON.stringify(parsed).length <= MAX_PROJECTED_BYTES) return parsed;
  } catch {
    // Not JSON: return the bounded text itself.
  }
  return joined.length <= MAX_PROJECTED_BYTES
    ? joined
    : joined.slice(0, MAX_PROJECTED_BYTES);
}

function parseAdvertisedTools(result: unknown): ExternalMcpTool[] | null {
  if (!isRecord(result) || !Array.isArray(result.tools)) return null;
  if (result.tools.length > MAX_ADVERTISED_TOOLS) return null;
  const tools: ExternalMcpTool[] = [];
  for (const entry of result.tools) {
    if (!isRecord(entry)) return null;
    const name = entry.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 120)
      return null;
    const inputSchema = entry.inputSchema;
    if (!isRecord(inputSchema)) return null;
    const description =
      typeof entry.description === "string"
        ? entry.description.slice(0, 500)
        : null;
    tools.push({
      name,
      description,
      inputSchema,
      schemaHash: schemaHash(inputSchema),
    });
  }
  return tools;
}

export function createMcpClient(deps: McpClientDeps) {
  const fetchImpl = deps.fetch ?? fetch;
  const deadlineMs = deps.deadlineMs ?? MCP_CLIENT_DEADLINE_MS;
  const maxResponseBytes =
    deps.maxResponseBytes ?? MCP_CLIENT_MAX_RESPONSE_BYTES;
  const pinnedHashes = deps.schemaHashes ?? {};
  let nextId = 1;

  function gate(): URL | null {
    if (!deps.enabled) return null;
    return approvedEndpoint(deps.endpointUrl);
  }

  async function postRpc(
    endpoint: URL,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<RpcOutcome> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (deps.credential) headers.authorization = `Bearer ${deps.credential}`;
    // Do not trust the transport to observe the abort signal: race it against
    // the deadline, so an injected/fake or stalled fetch still times out.
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(endpoint.href, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: nextId++,
            method,
            params,
          }),
          redirect: "error",
          cache: "no-store",
          signal,
        }),
        aborted,
      ]);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (signal.aborted || name === "AbortError" || name === "TimeoutError")
        return { ok: false, status: "timeout" };
      return { ok: false, status: "unavailable" };
    }
    if (!response.ok) return { ok: false, status: "unavailable" };
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, status: "unavailable" };
    }
    if (Buffer.byteLength(text, "utf8") > maxResponseBytes)
      return { ok: false, status: "unavailable" };
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, status: "unavailable" };
    }
    if (
      !isRecord(payload) ||
      payload.jsonrpc !== "2.0" ||
      !("result" in payload) ||
      ("error" in payload && payload.error !== undefined)
    )
      return { ok: false, status: "unavailable" };
    return { ok: true, result: payload.result };
  }

  async function loadTools(
    endpoint: URL,
  ): Promise<
    | { ok: true; tools: ExternalMcpTool[] }
    | { ok: false; status: Exclude<McpClientStatus, "ok"> }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const initialized = await postRpc(
        endpoint,
        "initialize",
        {
          protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "wukong-studio", version: "0.1.0" },
        },
        controller.signal,
      );
      if (!initialized.ok) return initialized;
      const listed = await postRpc(
        endpoint,
        "tools/list",
        {},
        controller.signal,
      );
      if (!listed.ok) return listed;
      const tools = parseAdvertisedTools(listed.result);
      if (!tools) return { ok: false, status: "unavailable" };
      return { ok: true, tools };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listTools(): Promise<McpToolListResult> {
      const endpoint = gate();
      if (!endpoint) return { status: "unavailable" };
      const loaded = await loadTools(endpoint);
      if (!loaded.ok) return { status: loaded.status };
      return { status: "ok", tools: loaded.tools };
    },

    async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
      const endpoint = gate();
      if (!endpoint) return { status: "unavailable" };
      if (
        typeof name !== "string" ||
        name.length === 0 ||
        name.length > 120 ||
        !deps.toolAllowlist.includes(name)
      )
        return { status: "denied" };
      const pinned = pinnedHashes[name];
      if (!pinned || !SHA256_HEX.test(pinned)) return { status: "denied" };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadlineMs);
      try {
        const initialized = await postRpc(
          endpoint,
          "initialize",
          {
            protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "wukong-studio", version: "0.1.0" },
          },
          controller.signal,
        );
        if (!initialized.ok) return { status: initialized.status };
        const listed = await postRpc(
          endpoint,
          "tools/list",
          {},
          controller.signal,
        );
        if (!listed.ok) return { status: listed.status };
        const tools = parseAdvertisedTools(listed.result);
        if (!tools) return { status: "unavailable" };
        const advertised = tools.find((tool) => tool.name === name);
        if (!advertised) return { status: "denied" };
        // Activation-time pin: required-field drift fails closed and no tool
        // call is sent.
        if (advertised.schemaHash !== pinned) return { status: "schema_drift" };

        const called = await postRpc(
          endpoint,
          "tools/call",
          { name, arguments: args ?? {} },
          controller.signal,
        );
        if (!called.ok) return { status: called.status };
        if (!isRecord(called.result)) return { status: "unavailable" };
        if (called.result.isError === true) return { status: "unavailable" };
        const output = projectToolResult(called.result);
        if (output === null) return { status: "unavailable" };
        return { status: "ok", output };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type McpClient = ReturnType<typeof createMcpClient>;
