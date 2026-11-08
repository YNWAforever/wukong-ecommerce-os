import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../lib/studio/route-deps";
import {
  createMcpTokenBodySchema,
  createMcpTokenService,
} from "../../../../lib/studio/mcp-tokens";

/**
 * Workspace MCP token administration (plan Task 12).
 *
 * `GET` lists token metadata and `POST` creates one; both are admin-only via
 * `requireStudioSession(deps, "admin")`. The plaintext token is returned by
 * `POST` exactly once and never appears in a list response, an audit row or a
 * log line.
 */

export function createMcpTokenHandlers(deps: StudioRouteDeps) {
  const service = () => createMcpTokenService(studioServiceDeps(deps));
  return {
    GET: async (_request: Request) =>
      withRouteErrors(async () => {
        const listed = await service().listTokens();
        return jsonResponse(200, { ...listed });
      }),
    POST: async (request: Request) =>
      withRouteErrors(async () => {
        let json: unknown;
        try {
          json = await request.json();
        } catch {
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        }
        const parsed = createMcpTokenBodySchema.safeParse(json);
        if (!parsed.success) {
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        }
        const created = await service().createToken(parsed.data);
        return jsonResponse(201, { ...created });
      }),
  };
}

const handlers = createMcpTokenHandlers({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
