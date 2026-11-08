import { createHash } from "node:crypto";

import { z } from "zod";

import {
  getTool,
  STUDIO_ROLE_RANK,
  TOOL_DEFINITIONS,
  type StudioRole,
  type ToolDefinition,
} from "@wukong/core";
import type { Database } from "@wukong/db";

import {
  isStudioMcpServerEnabled,
  type StudioFlagSettings,
} from "../studio-flags";
import { hashMcpTokenSecret, MCP_TOKEN_PLAINTEXT_PREFIX } from "./mcp-tokens";
import { buildStudioReadDeps } from "./read-deps";
import { runStudioTool, type ToolRun } from "./tools";

/**
 * Wukong-hosted MCP server (plan Task 12, spec §3.7).
 *
 * Stateless JSON-RPC 2.0 over HTTP POST with JSON responses — no SSE stream,
 * no session, no server-initiated messages. Every request is authorised from a
 * workspace token that resolves cross-workspace through migration 0055, then
 * the creator's *current* membership supplies the acting role. Only reviewed
 * read/propose tools are exposed; dispatch tools (and anything that writes,
 * approves or publishes) never appear in `tools/list` and are rejected by
 * `tools/call`.
 *
 * Untrusted-data rules the transport keeps:
 *  - arguments are validated with the same zod schema the internal loop uses;
 *  - the tool executes inside `db.forWorkspace` with the token's workspace;
 *  - requests are capped at 64 KiB and each tool call at 20 s;
 *  - the ledger records digests only; args, output and tokens are never logged.
 */

/** Current MCP specification revision (verified 2026-11-08). */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_SERVER_NAME = "wukong-eommerce-studio";
export const MCP_SERVER_VERSION = "0.1.0";

/** One bounded request per call; there is no batch or stream support. */
export const MCP_MAX_REQUEST_BYTES = 64 * 1024;
export const MCP_TOOL_DEADLINE_MS = 20_000;

/** JSON-RPC error codes used by this server (implementation-defined range). */
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
const RPC_UNAUTHORIZED = -32001;
const RPC_DEADLINE_EXCEEDED = -32002;

const BEARER_TOKEN =
  /^Bearer\s+(wuk_([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]{1,128}))$/i;

/** Workspace settings are all this transport needs from the flag parser. */
const ENABLED_PROBE: StudioFlagSettings = {
  enabled: true,
  defaultHome: false,
  ai: null,
};

type StudioMcpCallStatus =
  "ok" | "unavailable" | "schema_drift" | "denied" | "error";

/** The unscoped database surface the MCP transport may use. */
export type McpDatabase = Pick<
  Database,
  "forWorkspace" | "lookupStudioApiToken"
>;

export type McpServerDeps = {
  getDatabase: () => McpDatabase;
  /** `isStudioMcpServerEnabled` from `../studio-flags` by default. */
  isMcpServerEnabled?: (
    env: NodeJS.ProcessEnv,
    settings: StudioFlagSettings,
  ) => boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  deadlineMs?: number;
};

type Envelope =
  | {
      kind: "request";
      id: string | number | null;
      method: string;
      params: unknown;
    }
  | { kind: "notification"; method: string };

type RequestContext = {
  db: McpDatabase;
  workspaceId: string;
  tokenId: string;
  createdBy: string;
  scopes: string[];
  role: StudioRole;
};

type McpCallRecording = {
  toolName: string;
  requestDigest: string;
  responseDigest: string | null;
  status: StudioMcpCallStatus;
  errorCode: string | null;
  latencyMs: number;
};

class McpDeadlineExceeded extends Error {
  constructor() {
    super("mcp_tool_deadline_exceeded");
    this.name = "McpDeadlineExceeded";
  }
}

/** Deterministic JSON for digests: object keys sorted at every depth. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestToolArguments(args: unknown): string {
  return sha256Hex(stableStringify(args));
}

/** Parse `Authorization: Bearer wuk_<prefix>.<secret>`; else null. */
export function parseBearerToken(
  header: string | null,
): { prefix: string; secret: string; token: string } | null {
  if (!header) return null;
  const match = BEARER_TOKEN.exec(header.trim());
  if (!match) return null;
  return { token: match[1]!, prefix: match[2]!, secret: match[3]! };
}

function jsonResponse(
  status: number,
  body: Record<string, unknown> | null,
  headers: Record<string, string> = {},
): Response {
  const common = { "Cache-Control": "no-store", ...headers };
  if (body === null) return new Response(null, { status, headers: common });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...common },
  });
}

function rpcResult(
  id: string | number | null,
  result: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseEnvelope(value: unknown): Envelope | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") return null;
  if (
    typeof record.method !== "string" ||
    record.method.length === 0 ||
    record.method.length > 120
  )
    return null;
  if (!("id" in record) || record.id === undefined) {
    return { kind: "notification", method: record.method };
  }
  const id = record.id;
  if (typeof id === "string" && id.length <= 200) {
    return {
      kind: "request",
      id,
      method: record.method,
      params: record.params,
    };
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return {
      kind: "request",
      id,
      method: record.method,
      params: record.params,
    };
  }
  if (id === null) {
    return {
      kind: "request",
      id,
      method: record.method,
      params: record.params,
    };
  }
  return null;
}

function paramsObject(params: unknown): Record<string, unknown> | null {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) return null;
  return params as Record<string, unknown>;
}

/** Only reviewed read/propose tools within the token scopes and role floor. */
export function exposedTools(
  role: StudioRole,
  scopes: readonly string[],
): ToolDefinition[] {
  const rank = STUDIO_ROLE_RANK[role];
  return TOOL_DEFINITIONS.filter((tool) => {
    if (tool.kind !== "read" && tool.kind !== "propose") return false;
    const scope = tool.kind === "read" ? "read" : "propose";
    if (!scopes.includes(scope)) return false;
    return rank >= STUDIO_ROLE_RANK[tool.minRole];
  });
}

function toolDescription(tool: ToolDefinition): string {
  const access =
    tool.kind === "read"
      ? "Read-only workspace records access; it never writes, approves or publishes."
      : "Creates a reviewable proposal artifact only; it never writes canonical data.";
  return `${tool.label.en}. ${access} Dispatch and every write path are outside this endpoint.`;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpDeadlineExceeded()), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createMcpServer(deps: McpServerDeps) {
  const clock = (): number => deps.now?.() ?? Date.now();
  const deadlineMs = deps.deadlineMs ?? MCP_TOOL_DEADLINE_MS;
  const environment = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const flagEnabled = (
    env: NodeJS.ProcessEnv,
    settings: StudioFlagSettings,
  ): boolean =>
    (deps.isMcpServerEnabled ?? isStudioMcpServerEnabled)(env, settings);

  async function recordCall(
    db: McpDatabase,
    workspaceId: string,
    tokenId: string,
    actorId: string,
    recording: McpCallRecording,
  ): Promise<void> {
    await db.forWorkspace(workspaceId, async (repos) => {
      await repos.studio.mcpCalls.append({
        runId: null,
        connectionId: null,
        toolName: recording.toolName,
        requestDigest: recording.requestDigest,
        responseDigest: recording.responseDigest,
        status: recording.status,
        errorCode: recording.errorCode,
        latencyMs: recording.latencyMs,
        caller: "external_mcp",
      });
      await repos.audit.write({
        workspaceId,
        actorId,
        entityId: tokenId,
        action: "studio.mcp.call",
        metadata: {
          tool: recording.toolName,
          argumentsDigest: recording.requestDigest,
          outcome: recording.status,
          durationMs: recording.latencyMs,
        },
      });
      await repos.studio.apiTokens.touch(tokenId);
    });
  }

  async function recordFailure(
    context: RequestContext,
    toolName: string,
    args: unknown,
    status: StudioMcpCallStatus,
    errorCode: string,
    latencyMs: number,
  ): Promise<void> {
    try {
      await recordCall(
        context.db,
        context.workspaceId,
        context.tokenId,
        context.createdBy,
        {
          toolName,
          requestDigest: digestToolArguments(args),
          responseDigest: null,
          status,
          errorCode,
          latencyMs,
        },
      );
    } catch {
      // The JSON-RPC answer must not depend on a best-effort ledger write.
      // Event name only: never args, output or token material.
      console.error(JSON.stringify({ event: "studio_mcp_call_record_failed" }));
    }
  }

  async function dispatch(
    context: RequestContext,
    envelope: Extract<Envelope, { kind: "request" }>,
  ): Promise<Response> {
    const { id, method } = envelope;
    if (method === "initialize") {
      const params = paramsObject(envelope.params);
      if (!params)
        return jsonResponse(
          200,
          rpcError(id, RPC_INVALID_PARAMS, "Invalid params."),
        );
      const requested = params.protocolVersion;
      if (requested !== undefined && requested !== MCP_PROTOCOL_VERSION) {
        // A client may only use the revision this server implements.
        return jsonResponse(
          200,
          rpcError(id, RPC_INVALID_PARAMS, "Unsupported protocol version."),
        );
      }
      return jsonResponse(
        200,
        rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        }),
      );
    }

    if (method === "ping") {
      return jsonResponse(200, rpcResult(id, {}));
    }

    if (method === "tools/list") {
      const tools = exposedTools(context.role, context.scopes).map((tool) => ({
        name: tool.id,
        description: toolDescription(tool),
        inputSchema: z.toJSONSchema(tool.input),
      }));
      return jsonResponse(200, rpcResult(id, { tools }));
    }

    if (method === "tools/call") {
      return await callTool(context, envelope);
    }

    return jsonResponse(
      200,
      rpcError(id, RPC_METHOD_NOT_FOUND, "Method not found."),
    );
  }

  async function callTool(
    context: RequestContext,
    envelope: Extract<Envelope, { kind: "request" }>,
  ): Promise<Response> {
    const params = paramsObject(envelope.params);
    if (!params)
      return jsonResponse(
        200,
        rpcError(envelope.id, RPC_INVALID_PARAMS, "Invalid params."),
      );
    const name = params.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 120)
      return jsonResponse(
        200,
        rpcError(envelope.id, RPC_INVALID_PARAMS, "Invalid params."),
      );
    const args = params.arguments ?? {};

    const definition = getTool(name);
    if (!definition) {
      await recordFailure(context, name, args, "denied", "unknown_tool", 0);
      return jsonResponse(
        200,
        rpcError(envelope.id, RPC_INVALID_PARAMS, "Unknown tool."),
      );
    }

    // Dispatch tools are never advertised; the same allowlist decides here, so
    // a caller cannot reach one by naming it directly.
    const allowed = exposedTools(context.role, context.scopes).some(
      (tool) => tool.id === definition.id,
    );
    if (!allowed) {
      await recordFailure(
        context,
        definition.id,
        args,
        "denied",
        "tool_not_available",
        0,
      );
      return jsonResponse(
        200,
        rpcError(envelope.id, RPC_INVALID_PARAMS, "Tool is not available."),
      );
    }

    const parsed = definition.input.safeParse(args);
    if (!parsed.success) {
      await recordFailure(
        context,
        definition.id,
        args,
        "schema_drift",
        "invalid_arguments",
        0,
      );
      return jsonResponse(
        200,
        rpcResult(envelope.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "invalid_arguments" }),
            },
          ],
          isError: true,
        }),
      );
    }

    const startedAt = clock();
    try {
      const outcome = await withDeadline(
        context.db.forWorkspace(context.workspaceId, async (repos) => {
          const run = await runStudioTool({
            toolId: definition.id,
            rawInput: parsed.data,
            role: context.role,
            deps: buildStudioReadDeps(repos),
          });
          if (clock() - startedAt > deadlineMs) throw new McpDeadlineExceeded();
          const latencyMs = Math.max(0, Math.round(clock() - startedAt));
          const status: StudioMcpCallStatus =
            run.state === "done"
              ? "ok"
              : run.state === "unavailable"
                ? "unavailable"
                : "denied";
          await repos.studio.mcpCalls.append({
            runId: null,
            connectionId: null,
            toolName: definition.id,
            requestDigest: digestToolArguments(parsed.data),
            responseDigest:
              run.state === "done"
                ? sha256Hex(stableStringify(run.output))
                : null,
            status,
            errorCode: run.state === "done" ? null : `tool_${run.state}`,
            latencyMs,
            caller: "external_mcp",
          });
          await repos.audit.write({
            workspaceId: context.workspaceId,
            actorId: context.createdBy,
            entityId: context.tokenId,
            action: "studio.mcp.call",
            metadata: {
              tool: definition.id,
              argumentsDigest: digestToolArguments(parsed.data),
              outcome: status,
              durationMs: latencyMs,
            },
          });
          await repos.studio.apiTokens.touch(context.tokenId);
          return run;
        }),
        deadlineMs,
      );

      if (outcome.state === "done") {
        return jsonResponse(
          200,
          rpcResult(envelope.id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(outcome.output) ?? "null",
              },
            ],
          }),
        );
      }
      return jsonResponse(
        200,
        rpcResult(envelope.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                toolId: definition.id,
                state: outcome.state,
              }),
            },
          ],
          isError: true,
        }),
      );
    } catch (error) {
      if (error instanceof McpDeadlineExceeded) {
        const elapsed = Math.max(0, Math.round(clock() - startedAt));
        await recordFailure(
          context,
          definition.id,
          parsed.data,
          "error",
          "deadline_exceeded",
          elapsed,
        );
        return jsonResponse(
          200,
          rpcError(envelope.id, RPC_DEADLINE_EXCEEDED, "Tool call timed out."),
        );
      }
      await recordFailure(
        context,
        definition.id,
        parsed.data,
        "error",
        "tool_error",
        Math.max(0, Math.round(clock() - startedAt)),
      );
      return jsonResponse(
        200,
        rpcError(envelope.id, RPC_INTERNAL_ERROR, "Internal error."),
      );
    }
  }

  async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse(
        405,
        rpcError(null, RPC_INVALID_REQUEST, "Method not allowed."),
        { Allow: "POST" },
      );
    }
    const env = environment();
    if (!flagEnabled(env, ENABLED_PROBE)) {
      // Disabled before auth, token resolution or SQL: no oracle for callers.
      return jsonResponse(404, rpcError(null, RPC_UNAUTHORIZED, "Not found."));
    }

    const bearer = parseBearerToken(request.headers.get("authorization"));
    if (!bearer) {
      return jsonResponse(
        401,
        rpcError(null, RPC_UNAUTHORIZED, "Unauthorized."),
      );
    }

    const declaredLength = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MCP_MAX_REQUEST_BYTES
    ) {
      return jsonResponse(
        413,
        rpcError(null, RPC_INVALID_REQUEST, "Request body is too large."),
      );
    }
    let text: string;
    try {
      text = await request.text();
    } catch {
      return jsonResponse(
        400,
        rpcError(null, RPC_INVALID_REQUEST, "Invalid request."),
      );
    }
    if (Buffer.byteLength(text, "utf8") > MCP_MAX_REQUEST_BYTES) {
      return jsonResponse(
        413,
        rpcError(null, RPC_INVALID_REQUEST, "Request body is too large."),
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return jsonResponse(
        400,
        rpcError(null, RPC_INVALID_REQUEST, "Invalid request."),
      );
    }
    const envelope = parseEnvelope(payload);
    if (!envelope) {
      return jsonResponse(
        400,
        rpcError(null, RPC_INVALID_REQUEST, "Invalid request."),
      );
    }

    try {
      const db = deps.getDatabase();
      const resolved = await db.lookupStudioApiToken(
        hashMcpTokenSecret(bearer.secret),
      );
      if (
        !resolved ||
        resolved.prefix !== bearer.prefix ||
        resolved.revokedAt !== null
      ) {
        return jsonResponse(
          401,
          rpcError(null, RPC_UNAUTHORIZED, "Unauthorized."),
        );
      }

      const gate = await db.forWorkspace(
        resolved.workspaceId,
        async (repos) => ({
          settings: await repos.studio.settings.get(),
          membership: await repos.memberships.findActiveByUserId(
            resolved.createdBy,
            resolved.workspaceId,
          ),
        }),
      );
      if (!flagEnabled(env, gate.settings)) {
        return jsonResponse(
          404,
          rpcError(null, RPC_UNAUTHORIZED, "Not found."),
        );
      }
      // Token creator must still be an active member: a removed or demoted
      // creator fails closed on the next call.
      if (!gate.membership) {
        return jsonResponse(
          401,
          rpcError(null, RPC_UNAUTHORIZED, "Unauthorized."),
        );
      }

      const context: RequestContext = {
        db,
        workspaceId: resolved.workspaceId,
        tokenId: resolved.tokenId,
        createdBy: resolved.createdBy,
        scopes: resolved.scopes,
        role: gate.membership.role as StudioRole,
      };

      if (envelope.kind === "notification") {
        // JSON-RPC notifications get no response body (initialize's follow-up).
        return jsonResponse(202, null);
      }

      return await dispatch(context, envelope);
    } catch (error) {
      if (error instanceof McpDeadlineExceeded) {
        return jsonResponse(
          200,
          rpcError(null, RPC_DEADLINE_EXCEEDED, "Tool call timed out."),
        );
      }
      console.error(JSON.stringify({ event: "studio_mcp_request_failed" }));
      return jsonResponse(
        500,
        rpcError(null, RPC_INTERNAL_ERROR, "Internal error."),
      );
    }
  }

  return { handle };
}

export type McpServer = ReturnType<typeof createMcpServer>;
