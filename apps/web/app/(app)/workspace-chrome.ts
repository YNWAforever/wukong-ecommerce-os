import { getDatabase } from "../../lib/intake-runtime";
import type { WorkspaceRole } from "../../lib/session-context";
import { ROLE_LABELS } from "./shell-nav-items";

export const FALLBACK_WORKSPACE_NAME = "Wukong";

export type WorkspaceChromeSession = {
  workspaceId: string;
  role: WorkspaceRole;
};

export type WorkspaceChromeDeps = {
  getDatabase: typeof getDatabase;
};

export type WorkspaceChrome = {
  workspaceName: string;
  roleLabel: (typeof ROLE_LABELS)[WorkspaceRole];
};

/**
 * This layout renders on every `(app)` route, so a workspace-profile read
 * failure here (Neon/Hyperdrive cold start, pool exhaustion, a missing
 * DATABASE_URL, or workspaceProfileSchema drift) must degrade to the generic
 * fallback name instead of taking every page down with an uncaught throw.
 */
export async function resolveWorkspaceChrome(
  session: WorkspaceChromeSession | null,
  deps: WorkspaceChromeDeps = { getDatabase },
): Promise<WorkspaceChrome> {
  const roleLabel = session ? ROLE_LABELS[session.role] : ROLE_LABELS.viewer;
  if (!session) {
    return { workspaceName: FALLBACK_WORKSPACE_NAME, roleLabel };
  }

  try {
    const profile = await deps
      .getDatabase()
      .forWorkspace(session.workspaceId, (repositories) =>
        repositories.workspaces.requireProfile(),
      );
    return { workspaceName: profile.name, roleLabel };
  } catch (error) {
    // Name only, never the message: an unexpected error can carry a
    // connection string, matching the pattern in lib/route-support.ts.
    console.info(
      JSON.stringify({
        event: "app_shell_workspace_chrome_fallback",
        outcome: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return { workspaceName: FALLBACK_WORKSPACE_NAME, roleLabel };
  }
}
