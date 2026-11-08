import type { Database, StudioSettings } from "@wukong/db";

import { ApiError, requireSessionContext } from "../route-support";
import { requireWorkspaceRole, type WorkspaceRole } from "../session-context";
import type {
  SessionContext,
  SessionContextPort,
} from "../session-context-port";
import type { StudioFlagSettings } from "../studio-flags";

/**
 * The shared Studio gate (plan Task 6, spec §3.2 step order).
 *
 * Every route and service method starts here: the session comes from
 * `authSessionContext`, the workspace's settings row is read through
 * `forWorkspace`, the fail-closed flags module decides whether the feature
 * exists for this deployment *and* workspace, and only then does the role
 * floor apply. A disabled Studio is a 404 (never a redirect loop and never a
 * hint that the surface exists); a foreign or malformed workspace row can only
 * produce the same 404.
 *
 * `deps` is injected so tests can fake the session, the database and the flags
 * without a live Postgres or environment.
 */

/** The subset of `Database` the Studio needs. */
export type StudioDatabase = Pick<Database, "forWorkspace">;

export type StudioSessionDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => StudioDatabase;
  /**
   * `isStudioEnabled` from `../studio-flags` by default. It is injected here
   * as a narrow function so tests can turn the feature on and off explicitly
   * instead of mutating `process.env`.
   */
  isStudioEnabled: (
    env: NodeJS.ProcessEnv,
    settings: StudioFlagSettings,
  ) => boolean;
  env?: NodeJS.ProcessEnv;
};

export type StudioSession = {
  session: SessionContext;
  settings: StudioSettings;
  role: WorkspaceRole;
};

/** The one message a disabled or foreign Studio resource ever returns. */
export const STUDIO_NOT_FOUND_MESSAGE = "Not found.";

export function studioNotFound(): ApiError {
  return new ApiError(404, "not_found", STUDIO_NOT_FOUND_MESSAGE);
}

/**
 * Resolve and gate one Studio request.
 *
 * Order matters and is tested: unauthenticated is 401, a disabled Studio is
 * 404 before any domain work, and a role below the floor is 403. Nothing here
 * reads a workspace or role from request input.
 */
export async function requireStudioSession(
  deps: StudioSessionDeps,
  minimumRole: WorkspaceRole = "viewer",
): Promise<StudioSession> {
  const session = await requireSessionContext(deps.sessionContext);
  const settings = await deps.getDatabase().forWorkspace(
    session.workspaceId,
    (repos) => repos.studio.settings.get(),
  );
  const env = deps.env ?? process.env;
  if (!deps.isStudioEnabled(env, settings)) {
    throw studioNotFound();
  }
  if (!requireWorkspaceRole(minimumRole, session.role)) {
    throw new ApiError(403, "insufficient_role", "Insufficient role.");
  }
  return { session, settings, role: session.role };
}
