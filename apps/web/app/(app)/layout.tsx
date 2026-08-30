import Link from "next/link";

import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../lib/session-context";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await authSessionContext.resolve();
  const isAdmin = session ? requireWorkspaceRole("admin", session.role) : false;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要內容 <span>Skip to content</span>
      </a>
      <header className="topbar">
        <div className="brand-lockup">
          <Link
            className="brand-mark"
            href="/dashboard"
            aria-label="Wukong home"
          >
            W
          </Link>
          <div>
            <Link className="brand-name" href="/dashboard">
              Wukong
            </Link>
            <span className="brand-context">Opak Cellar</span>
          </div>
        </div>
        <nav aria-label="主要導覽">
          <Link href="/dashboard">
            工作台 <span>Workspace</span>
          </Link>
          <Link href="/catalog">
            商品中心 <span>Catalog</span>
          </Link>
          <Link href="/listings/new">
            建立草稿 <span>New listing</span>
          </Link>
          <Link href="/listings/import">
            SHOPLINE 匯入 <span>Bulk import</span>
          </Link>
          {isAdmin ? (
            <Link href="/admin">
              管理 <span>Admin</span>
            </Link>
          ) : null}
        </nav>
        <div className="topbar-meta">
          <span className="pilot-badge">PILOT</span>
          <span className="operator-name">Opak operator</span>
        </div>
      </header>
      <main id="main-content" className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <span>Wukong Ecommerce OS</span>
        <span>Opak Cellar pilot · HKD · en / zh-Hant</span>
      </footer>
    </div>
  );
}
