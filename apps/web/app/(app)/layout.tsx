import { localized } from "../../lib/ui-copy";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readWorkspaceAccount } from "../../lib/account-read";
import { getDatabase } from "../../lib/intake-runtime";

import { AppShellNav } from "../../components/app-shell-nav";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../lib/session-context";
import { isStudioEnabled, isStudioFeatureFlagOn } from "../../lib/studio-flags";
import { listUserWorkspaces } from "../../lib/workspace-selection";
import { visibleNavItems, withStudioNavItem } from "./shell-nav-items";
import { resolveWorkspaceChrome } from "./workspace-chrome";

/**
 * Whether this workspace should see the Studio nav item.
 *
 * Two conditions, both server-only: the deployment flag AND the workspace
 * `studio_workspace_settings` row (a missing row means disabled defaults).
 * The read happens once per shell render, here rather than in the nav client
 * component, so no flag value reaches the browser.
 *
 * A failure -- cold database, pool exhaustion, migration not applied -- fails
 * closed to disabled: Studio must never break the app shell that every other
 * route depends on. Only the error name is logged, matching
 * `workspace-chrome.ts`, because a raw message can carry a connection string.
 */
async function readStudioEnabled(workspaceId: string): Promise<boolean> {
  // Default-off shortcut: while the deployment flag is off (the shipped
  // state), the shell must not open a workspace transaction just to learn
  // that Studio is disabled. Exactly the env half of `isStudioEnabled`.
  if (!isStudioFeatureFlagOn(process.env)) return false;
  try {
    const settings = await getDatabase().forWorkspace(workspaceId, (repos) =>
      repos.studio.settings.get(),
    );
    return isStudioEnabled(process.env, settings);
  } catch (error) {
    console.info(
      JSON.stringify({
        event: "app_shell_studio_flag_read_fallback",
        outcome: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return false;
  }
}

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await authSessionContext.resolve();
  if (!session) redirect("/signin");
  const account = await getDatabase().forWorkspace(
    session.workspaceId,
    (repos) => readWorkspaceAccount(repos, session),
  );
  const isAdmin = requireWorkspaceRole("admin", account.role);
  const studioEnabled = await readStudioEnabled(session.workspaceId);
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const { workspaceName, roleLabel } = await resolveWorkspaceChrome({
    ...session,
    role: account.role,
  });
  const workspaceOptions = session
    ? await listUserWorkspaces(session.actorId)
    : [];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {localized(locale, "跳到主要內容", "Skip to content")}
      </a>
      <header className="topbar">
        <AppShellNav
          navItems={withStudioNavItem(
            visibleNavItems(account.role),
            studioEnabled,
          )}
          isAdmin={isAdmin}
          workspaceName={workspaceName}
          activeWorkspaceId={session?.workspaceId}
          workspaceOptions={workspaceOptions}
          roleLabelZh={roleLabel.zh}
          roleLabelEn={roleLabel.en}
          accountUser={account.user}
          initialLocale={locale}
        />
      </header>
      <main id="main-content" className="app-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="app-footer">
        <span>Wukong Ecommerce OS</span>
        <span>
          {workspaceName} · HKD ·{" "}
          {localized(locale, "試行工作區", "Pilot workspace")}
        </span>
      </footer>
    </div>
  );
}
