import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { StudioShell } from "../../../components/studio-shell";
import { getDatabase } from "../../../lib/intake-runtime";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";
import { isStudioEnabled } from "../../../lib/studio-flags";
import { resolveWorkspaceChrome } from "../workspace-chrome";
import { studioService } from "./studio-service";

/**
 * Gate for every `/studio` route.
 *
 * Order matters and is the same one Task 6's APIs use: session first, then the
 * workspace's Studio settings row, then the flags. A missing row means the
 * repository returns disabled defaults, so a workspace that never opted in
 * gets a 404 even if the deployment flag is on.
 *
 * A settings read failure fails closed to 404 rather than a crash or a
 * half-rendered shell: the `(app)` layout hides the nav item on the same
 * failure, so direct access must not become the only visible Studio surface.
 * The `(app)` layout resolves the session too; `authSessionContext.resolve` is
 * wrapped in React `cache()`, so this is the same per-request result.
 *
 * The recent-conversation list is read through the same Studio service. A
 * failure there is not a reason to hide the enabled Studio surface: it logs a
 * content-free diagnostic and renders the rail's honest empty state instead.
 */
export default async function StudioLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await authSessionContext.resolve();
  if (!session) redirect("/signin");

  const settings = await getDatabase()
    .forWorkspace(session.workspaceId, (repos) => repos.studio.settings.get())
    .catch((error: unknown) => {
      // Name only, never the message: an unexpected error can carry a
      // connection string (matching app/(app)/workspace-chrome.ts).
      console.info(
        JSON.stringify({
          event: "studio_layout_settings_read_failed",
          outcome: "failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return null;
    });

  if (!isStudioEnabled(process.env, settings)) notFound();

  const recentThreads = await studioService()
    .listThreads()
    .catch((error: unknown) => {
      console.info(
        JSON.stringify({
          event: "studio_layout_threads_read_failed",
          outcome: "failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return { items: [], truncated: false };
    });

  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const { workspaceName } = await resolveWorkspaceChrome({
    workspaceId: session.workspaceId,
    role: session.role,
  });

  return (
    <StudioShell
      locale={locale}
      workspaceName={workspaceName}
      recentThreads={recentThreads.items}
      recentTruncated={recentThreads.truncated}
      canCreateThread={requireWorkspaceRole("operator", session.role)}
    >
      {children}
    </StudioShell>
  );
}
