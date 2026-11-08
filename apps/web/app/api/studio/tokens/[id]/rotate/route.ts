import { getDatabase } from "../../../../../../lib/intake-runtime";
import {
  jsonResponse,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../../lib/studio/route-deps";
import { createMcpTokenService } from "../../../../../../lib/studio/mcp-tokens";

/**
 * `POST /api/studio/tokens/[id]/rotate` (B4).
 *
 * Admin-only. Creates a replacement token with the same label, scopes and
 * quotas, revokes the old token in the same transaction, audits
 * `studio.mcp.token.rotated`, and returns the new plaintext exactly once. The
 * old plaintext is unrecoverable (only its hash was stored).
 */
export function createMcpTokenRotateHandler(deps: StudioRouteDeps) {
  return async (
    _request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const { id } = await context.params;
      const rotated = await createMcpTokenService(
        studioServiceDeps(deps),
      ).rotateToken(id);
      return jsonResponse(201, { ...rotated });
    });
}

const handlers = createMcpTokenRotateHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const POST = handlers;
