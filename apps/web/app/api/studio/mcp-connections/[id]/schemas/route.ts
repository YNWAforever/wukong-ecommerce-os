import { getDatabase } from "../../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import {
  createMcpConnectionService,
  pinMcpSchemaHashesBodySchema,
} from "../../../../../../lib/studio/mcp-connections";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../../lib/studio/route-deps";

/**
 * `PUT /api/studio/mcp-connections/[id]/schemas` — pin advertised schema hashes.
 *
 * Pinning only allowlisted tools; a pin change bumps the generation and returns
 * an approved connection to `draft`. No transport call happens here.
 */
export function createMcpSchemaPinsHandler(deps: StudioRouteDeps) {
  const service = () => createMcpConnectionService(studioServiceDeps(deps));
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
      const parsed = pinMcpSchemaHashesBodySchema.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(400, "invalid_body", "Request body is invalid.");
      }
      const updated = await service().pinSchemaHashes(id, parsed.data);
      return jsonResponse(200, { ...updated });
    });
}

const handlers = createMcpSchemaPinsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const PUT = handlers;
