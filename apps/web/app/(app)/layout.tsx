import { cookies } from "next/headers";

import { AppShellNav } from "../../components/app-shell-nav";
import { getDatabase } from "../../lib/intake-runtime";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../lib/session-context";
import { ROLE_LABELS, SHELL_NAV_ITEMS } from "./shell-nav-items";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await authSessionContext.resolve();
  const isAdmin = session ? requireWorkspaceRole("admin", session.role) : false;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  const workspaceName = session
    ? await getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          repositories.workspaces.requireProfile(),
        )
        .then((profile) => profile.name)
    : "Wukong";

  const roleLabel = session ? ROLE_LABELS[session.role] : ROLE_LABELS.viewer;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要內容 <span>Skip to content</span>
      </a>
      <header className="topbar">
        <AppShellNav
          navItems={SHELL_NAV_ITEMS}
          isAdmin={isAdmin}
          workspaceName={workspaceName}
          roleLabelZh={roleLabel.zh}
          roleLabelEn={roleLabel.en}
          initialLocale={locale}
        />
      </header>
      <main id="main-content" className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <span>Wukong Ecommerce OS</span>
        <span>{workspaceName} pilot · HKD · en / zh-Hant</span>
      </footer>
    </div>
  );
}
