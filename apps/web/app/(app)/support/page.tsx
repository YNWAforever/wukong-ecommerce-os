import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { SupportCard } from "../../../components/support-card";
import { readWorkspaceAccount } from "../../../lib/account-read";
import { getDatabase } from "../../../lib/intake-runtime";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import { authSessionContext } from "../../../lib/session-context";
import { localized } from "../../../lib/ui-copy";
export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ requestId?: string }>;
}) {
  const session = await authSessionContext.resolve();
  if (!session) redirect("/signin");
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const account = await getDatabase().forWorkspace(
    session.workspaceId,
    (repos) => readWorkspaceAccount(repos, session),
  );
  const params = await searchParams;
  return (
    <div className="page-wrap">
      <div className="page-header">
        <h1>{localized(locale, "支援", "Support")}</h1>
        <Link href="/catalog">
          {localized(locale, "返回商品中心", "Return to catalog")}
        </Link>
      </div>
      <SupportCard
        contacts={account.contacts}
        requestId={params.requestId}
        locale={locale}
      />
    </div>
  );
}
