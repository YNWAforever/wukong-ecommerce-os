import { localized } from "../../lib/ui-copy";
import { cookies } from "next/headers";

import { AppShellNav } from "../../components/app-shell-nav";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../lib/session-context";
import { SHELL_NAV_ITEMS } from "./shell-nav-items";
import { resolveWorkspaceChrome } from "./workspace-chrome";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await authSessionContext.resolve();
  const isAdmin = session ? requireWorkspaceRole("admin", session.role) : false;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const { workspaceName, roleLabel } = await resolveWorkspaceChrome(session);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {localized(locale, "跳到主要內容", "Skip to content")}
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
