import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import {
  createMcpConnectionBodySchema,
  createMcpConnectionService,
} from "../../../../lib/studio/mcp-connections";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../lib/studio/route-deps";

/**
 * External MCP connection registry (plan Task 13).
 *
 * Admin-only: `GET` returns the workspace snapshot with honest disabled-state
 * flags, `POST` records a draft connection. Neither route performs a network
 * call — approval is the explicit admin action that also requires the global
 * flag, the workspace row and the encryption key.
 */
export function createMcpConnectionHandlers(deps: StudioRouteDeps) {
  const service = () => createMcpConnectionService(studioServiceDeps(deps));
  return {
    GET: async (_request: Request) =>
      withRouteErrors(async () => {
        const snapshot = await service().listConnections();
        return jsonResponse(200, { ...snapshot });
      }),
    POST: async (request: Request) =>
      withRouteErrors(async () => {
        let json: unknown;
        try {
          json = await request.json();
        } catch {
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        }
        const parsed = createMcpConnectionBodySchema.safeParse(json);
        if (!parsed.success) {
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        }
        const created = await service().createDraftConnection(parsed.data);
        return jsonResponse(201, { ...created });
      }),
  };
}

const handlers = createMcpConnectionHandlers({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
