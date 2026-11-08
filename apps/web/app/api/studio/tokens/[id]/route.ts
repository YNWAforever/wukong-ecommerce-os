import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  jsonResponse,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../lib/studio/route-deps";
import { createMcpTokenService } from "../../../../../lib/studio/mcp-tokens";

/**
 * Revoke one workspace MCP token (`DELETE /api/studio/tokens/[id]`).
 * Admin-only, audited, 404 for an unknown or foreign token id.
 */
export function createMcpTokenRevokeHandler(deps: StudioRouteDeps) {
  return async (
    _request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const { id } = await context.params;
      const revoked = await createMcpTokenService(
        studioServiceDeps(deps),
      ).revokeToken(id);
      return jsonResponse(200, { ...revoked });
    });
}

const handlers = createMcpTokenRevokeHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const DELETE = handlers;
