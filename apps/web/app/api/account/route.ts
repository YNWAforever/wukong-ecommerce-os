import { getDatabase } from "../../../lib/intake-runtime";
import { readWorkspaceAccount } from "../../../lib/account-read";
import {
  createRouteDiagnostics,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import { authSessionContext } from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";
export function createAccountGetHandler(deps: {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
}) {
  return async (_request: Request) =>
    withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const account = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, (repos) =>
          readWorkspaceAccount(repos, context),
        );
      return jsonResponse(200, {
        ...account,
        workspaceId: context.workspaceId,
      });
    }, createRouteDiagnostics());
}
export const GET = createAccountGetHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
