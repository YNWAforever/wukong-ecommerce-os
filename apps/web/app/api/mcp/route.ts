import { getDatabase } from "../../../lib/intake-runtime";
import {
  createMcpServer,
  type McpDatabase,
  type McpServerDeps,
} from "../../../lib/studio/mcp-server";

/**
 * Hosted MCP endpoint (`POST /api/mcp`, plan Task 12 / spec §3.7).
 *
 * Thin Next.js adapter: the transport, auth, gates and JSON-RPC semantics all
 * live in `createMcpServer`, so this file only binds the real database and
 * declares the Node runtime (the Postgres driver and node:crypto require it).
 * `GET` is bound to the same handler, which answers 405; there is no SSE
 * stream in v1.
 */

export const runtime = "nodejs";

export type McpRouteDeps = {
  getDatabase: () => McpDatabase;
  isMcpServerEnabled?: McpServerDeps["isMcpServerEnabled"];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  deadlineMs?: number;
};

export function createMcpHandlers(deps: McpRouteDeps) {
  const server = createMcpServer(deps);
  return {
    GET: server.handle,
    POST: server.handle,
  };
}

const handlers = createMcpHandlers({ getDatabase });

export const GET = handlers.GET;
export const POST = handlers.POST;
