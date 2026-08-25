import { redirect } from "next/navigation";

import { AdminTabs } from "../../../components/admin-tabs";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";

export default async function AdminPage() {
  const session = await authSessionContext.resolve();
  if (!session || !requireWorkspaceRole("admin", session.role)) {
    redirect("/dashboard");
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
