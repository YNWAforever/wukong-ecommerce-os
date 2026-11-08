import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import {
  createMcpConnectionService,
  updateMcpConnectionBodySchema,
} from "../../../../../lib/studio/mcp-connections";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../lib/studio/route-deps";

/**
 * `PATCH /api/studio/mcp-connections/[id]` — explicit admin approve/disable
 * (plan Task 13). Approval is audited and fails closed while the global flag,
 * the workspace Studio row or the encryption key is missing.
 */
export function createMcpConnectionStatusHandler(deps: StudioRouteDeps) {
  return async (
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
      const parsed = updateMcpConnectionBodySchema.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(400, "invalid_body", "Request body is invalid.");
      }
      const updated = await createMcpConnectionService(
        studioServiceDeps(deps),
      ).updateConnectionStatus(id, parsed.data);
      return jsonResponse(200, { ...updated });
    });
}

const handlers = createMcpConnectionStatusHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const PATCH = handlers;
