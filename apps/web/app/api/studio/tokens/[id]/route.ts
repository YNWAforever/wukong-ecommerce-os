import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../lib/studio/route-deps";
import {
  createMcpTokenService,
  updateMcpTokenLimitsBodySchema,
} from "../../../../../lib/studio/mcp-tokens";

/**
 * One workspace MCP token (plan Task 12; B4 adds quota editing).
 *
 * `DELETE` revokes the token; `PATCH` updates only its two quota limits.
 * Both are admin-only, audited, and answer 404 for an unknown or foreign id.
 * The plaintext is never returned by either method.
 */
export function createMcpTokenHandler(deps: StudioRouteDeps) {
  const service = () => createMcpTokenService(studioServiceDeps(deps));
  return {
    DELETE: async (
      _request: Request,
      context: { params: Promise<{ id: string }> },
    ) =>
      withRouteErrors(async () => {
        const { id } = await context.params;
        const revoked = await service().revokeToken(id);
        return jsonResponse(200, { ...revoked });
      }),
    PATCH: async (
      request: Request,
      context: { params: Promise<{ id: string }> },
    ) =>
      withRouteErrors(async () => {
        const { id } = await context.params;
        let json: unknown;
        try {
          json = await request.json();
        } catch {
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        }
        const parsed = updateMcpTokenLimitsBodySchema.safeParse(json);
        if (!parsed.success) {
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        }
        const updated = await service().updateLimits(id, parsed.data);
        return jsonResponse(200, { ...updated });
      }),
  };
}

const handlers = createMcpTokenHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;
