import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";
import {
  summarizeWorkspaceReadiness,
  type ReadinessEnvironment,
} from "../../../../lib/workspace-readiness-summary";
type Deps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
  now: () => Date;
  env: ReadinessEnvironment;
};
export function createReadinessHandler(deps: Deps) {
  return async (_request: Request) =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("admin", session.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Admin access is required.",
        );
      const items = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repos) =>
          summarizeWorkspaceReadiness({
            profile: await repos.workspaces.requireProfile(),
            observations: await repos.workspaces.readinessObservations(),
            env: deps.env,
            now: deps.now(),
          }),
        );
      const response = jsonResponse(200, { items });
      response.headers.set("cache-control", "private, no-store");
      return response;
    });
}
export const GET = createReadinessHandler({
  sessionContext: authSessionContext,
  getDatabase,
  now: () => new Date(),
  env: {
    AI_PROVIDER: process.env.AI_PROVIDER,
    LISTING_PAID_OPERATIONS_ENABLED:
      process.env.LISTING_PAID_OPERATIONS_ENABLED,
  },
});
