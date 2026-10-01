import { redirect } from "next/navigation";
import Link from "next/link";

import { AdminTabs } from "../../../components/admin-tabs";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";

export default async function AdminPage() {
  const session = await authSessionContext.resolve();
  if (!session) redirect("/signin");
  if (!requireWorkspaceRole("admin", session.role)) {
    return (
      <div className="page-wrap">
        <section className="card">
          <h1>需要管理員權限 Admin access required</h1>
          <p>
            你的工作區角色無法管理成員、商店連線或設定。 Your workspace role
            cannot manage members, store connections or settings.
          </p>
          <p>
            如需更改設定，請聯絡工作區管理員。 Contact a workspace administrator
            if you need a settings change.
          </p>
          <Link className="button" href="/catalog">
            返回商品中心 Return to catalog
          </Link>
          <p>
            <Link href="/support">支援 Support</Link>
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-wrap admin-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            管理 <span>ADMIN</span>
          </p>
          <h1>工作區管理 Workspace administration</h1>
        </div>
      </div>
      <AdminTabs />
    </div>
  );
}
