import Link from "next/link";

import { DashboardListingsClient } from "../../../components/dashboard-listings-client";
import { authSessionContext } from "../../../lib/session-context";
import { resolveWorkspaceChrome } from "../workspace-chrome";

export default async function DashboardPage() {
  const session = await authSessionContext.resolve();
  const { workspaceName } = await resolveWorkspaceChrome(session);

  return (
    <div className="page-wrap">
      <div className="page-header dashboard-header">
        <div>
          <p className="eyebrow">
            {workspaceName} <span>OPAK PILOT WORKSPACE</span>
          </p>
          <h1>早上好，今天先處理最接近上架的酒款。</h1>
          <p className="lede">AI 只提出有來源的建議；你保留最後的審核權。</p>
        </div>
        <Link className="primary-button" href="/listings/new">
          建立上架草稿 <span>Create draft</span>
        </Link>
      </div>
      <DashboardListingsClient />
    </div>
  );
}
