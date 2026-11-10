import { getDatabase } from "../../../../../../lib/intake-runtime";
import {
  jsonResponse,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import { createMcpConnectionService } from "../../../../../../lib/studio/mcp-connections";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../../lib/studio/route-deps";

/**
 * `POST /api/studio/mcp-connections/[id]/probe` — explicit admin diagnostic.
 *
 * Calls `initialize` + `tools/list` on the endpoint through the reviewed
 * external MCP client and compares the advertised input-schema hashes with the
 * pinned snapshot. A draft may be probed so hashes can be pinned before
 * approval; a disabled connection is never probed. While the global flag, the
 * workspace Studio row or the encryption key is missing this route answers 409
 * and no transport call is made. The response contains tool names and hashes
 * only — never the endpoint, credential or provider payloads.
 */
export function createMcpProbeHandler(deps: StudioRouteDeps) {
  const service = () => createMcpConnectionService(studioServiceDeps(deps));
  return async (
    _request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const { id } = await context.params;
      const result = await service().probeConnection(id);
      return jsonResponse(200, { ...result });
    });
}

const handlers = createMcpProbeHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const POST = handlers;
