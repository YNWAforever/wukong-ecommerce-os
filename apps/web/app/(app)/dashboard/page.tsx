import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import { readPageCopy } from "../../../lib/read-page-copy";
import { commonCopy } from "../../../lib/ui-copy";
import Link from "next/link";

import { DashboardListingsClient } from "../../../components/dashboard-listings-client";
import { authSessionContext } from "../../../lib/session-context";
import { resolveWorkspaceChrome } from "../workspace-chrome";

export default async function DashboardPage() {
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const copy = readPageCopy.dashboard[locale];
  const session = await authSessionContext.resolve();
  const { workspaceName } = await resolveWorkspaceChrome(session);

  return (
    <div className="page-wrap">
      <div className="page-header dashboard-header">
        <div>
          <p className="eyebrow">
            {workspaceName} · {copy.eyebrow}
          </p>
          <h1>{copy.title}</h1>
          <p className="lede">{copy.description}</p>
        </div>
        <Link className="primary-button" href="/listings/new">
          {commonCopy[locale].createDraft}
        </Link>
      </div>
      <DashboardListingsClient />
    </div>
  );
}
