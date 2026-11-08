import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";

import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import { localized } from "../../../lib/ui-copy";
import { AdminTabs } from "../../../components/admin-tabs";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";

export default async function AdminPage() {
  const session = await authSessionContext.resolve();
  if (!session) redirect("/signin");
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const t = (zh: string, en: string) => localized(locale, zh, en);
  if (!requireWorkspaceRole("admin", session.role)) {
    return (
      <div className="page-wrap">
        <section className="card">
          <h1>{t("需要管理員權限", "Admin access required")}</h1>
          <p>
            {t(
              "你的工作區角色無法管理成員、商店連線或設定。",
              "Your workspace role cannot manage members, store connections or settings.",
            )}
          </p>
          <p>
            {t(
              "如需更改設定，請聯絡工作區管理員。",
              "Contact a workspace administrator if you need a settings change.",
            )}
          </p>
          <Link className="button" href="/catalog">
            {t("返回商品中心", "Return to catalog")}
          </Link>
          <p>
            <Link href="/support">{t("支援", "Support")}</Link>
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-wrap admin-page">
      <div className="page-header">
        <div>
          <h1>{t("工作區管理", "Workspace administration")}</h1>
          <p className="lede">
            {t(
              "管理成員、SHOPLINE 商店連線及工作區設定。",
              "Manage members, the SHOPLINE store connection and workspace settings.",
            )}
          </p>
        </div>
      </div>
      <AdminTabs />
    </div>
  );
}
