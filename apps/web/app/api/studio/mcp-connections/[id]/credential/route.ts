import { getDatabase } from "../../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import {
  createMcpConnectionService,
  setMcpCredentialBodySchema,
} from "../../../../../../lib/studio/mcp-connections";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../../lib/studio/route-deps";

/**
 * `PUT|DELETE /api/studio/mcp-connections/[id]/credential` — explicit admin
 * credential binding (plan Task 13, spec §3.8).
 *
 * The plaintext credential exists only inside this request and the encryption
 * helper. The response is the ordinary connection view, which reports only
 * whether a credential is present. Rotating or clearing it bumps the generation
 * and returns an approved connection to `draft`, so approval is repeated.
 */
export function createMcpCredentialHandler(deps: StudioRouteDeps) {
  const service = () => createMcpConnectionService(studioServiceDeps(deps));
  return {
    PUT: async (
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
        const parsed = setMcpCredentialBodySchema.safeParse(json);
        if (!parsed.success) {
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        }
        const updated = await service().setCredential(id, parsed.data);
        return jsonResponse(200, { ...updated });
      }),
    DELETE: async (
      _request: Request,
      context: { params: Promise<{ id: string }> },
    ) =>
      withRouteErrors(async () => {
        const { id } = await context.params;
        const updated = await service().clearCredential(id);
        return jsonResponse(200, { ...updated });
      }),
  };
}

const handlers = createMcpCredentialHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const PUT = handlers.PUT;
export const DELETE = handlers.DELETE;
