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
import { listUserWorkspaces } from "../../lib/workspace-selection";
import { visibleNavItems } from "./shell-nav-items";
import { resolveWorkspaceChrome } from "./workspace-chrome";

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
          navItems={visibleNavItems(account.role)}
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
