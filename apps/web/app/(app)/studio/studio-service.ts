import { getDatabase } from "../../../lib/intake-runtime";
import { authSessionContext } from "../../../lib/session-context";
import { isStudioAiEnabled, isStudioEnabled } from "../../../lib/studio-flags";
import { createStudioService } from "../../../lib/studio/turn-service";

/**
 * Server-side Studio service binding for the `/studio` pages (plan Task 7).
 *
 * The pages and the Task 6 APIs share the exact same factory and concrete
 * ports: session from `authSessionContext`, data through `getDatabase()`, and
 * the fail-closed flag parsers. Nothing here reads a workspace, role or flag
 * from request input. The layout has already enforced the gate for every
 * `/studio` route; this module only supplies the service the page needs.
 */

export function studioService() {
  return createStudioService({
    sessionContext: authSessionContext,
    getDatabase,
    isStudioEnabled,
    isStudioAiEnabled,
  });
}

/**
 * Whether live analysis is configured for this workspace.
 *
 * This is presentation context, not a security boundary: the turn service
 * re-checks the same flag and settings before it builds a model. A failed read
 * answers `false` so the UI says "not configured" rather than showing stale
 * optimism.
 */
export async function studioAiEnabled(): Promise<boolean> {
  try {
    const session = await authSessionContext.resolve();
    if (!session) return false;
    const settings = await getDatabase().forWorkspace(
      session.workspaceId,
      (repos) => repos.studio.settings.get(),
    );
    return isStudioAiEnabled(process.env, settings);
  } catch {
    return false;
  }
}
