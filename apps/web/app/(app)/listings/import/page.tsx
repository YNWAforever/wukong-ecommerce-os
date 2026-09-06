import Link from "next/link";
import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { localized } from "../../../../lib/ui-copy";
import { authSessionContext } from "../../../../lib/session-context";
import { ListingIntakeTabs } from "../../../../components/listing-intake-tabs";
export default async function ListingImportPage() {
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const session = await authSessionContext.resolve();
  const title = localized(locale, "商品目錄匯入", "Catalog import");
  return (
    <div className="page-wrap narrow-page">
      <div className="breadcrumb">
        <Link href="/dashboard">
          {localized(locale, "工作台", "Dashboard")}
        </Link>
        <span aria-hidden="true">/</span>
        <span>{title}</span>
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">{title}</p>
          <h1>{title}</h1>
          <p className="lede">
            {localized(
              locale,
              "貼上公開網站網址以預覽商品，或選擇 SHOPLINE 試算表匯入現有商品。",
              "Preview products from a public website, or choose a SHOPLINE workbook to import existing products.",
            )}
          </p>
        </div>
      </div>
      <ListingIntakeTabs
        canScan={Boolean(session && session.role !== "viewer")}
      />
    </div>
  );
}
