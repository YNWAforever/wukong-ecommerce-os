import { WorkbenchReturnLink } from "../../../../components/workbench-return-link";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { localized } from "../../../../lib/ui-copy";
import { authSessionContext } from "../../../../lib/session-context";
import { ListingIntakeChoices } from "../../../../components/listing-intake-choices";
import { initialMaintenanceIntent } from "../../../../lib/catalog-maintenance-intent";
export default async function ListingImportPage({
  searchParams,
}: {
  searchParams?: Promise<{
    returnTo?: string;
    intent?: string;
    referenceKind?: string;
    referenceId?: string;
    scan?: string;
  }>;
} = {}) {
  const query = (await searchParams) ?? {};
  if (query.intent === "new-draft") redirect("/listings/new");
  const candidate =
    query.referenceKind || query.referenceId
      ? z
          .object({ kind: z.enum(["workbook", "website"]), id: z.uuid() })
          .safeParse({ kind: query.referenceKind, id: query.referenceId })
      : null;
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const session = await authSessionContext.resolve();
  const title = localized(locale, "商品目錄匯入", "Catalog import");
  return (
    <div className="page-wrap narrow-page">
      {typeof query.returnTo === "string" ? (
        <WorkbenchReturnLink returnTo={query.returnTo} />
      ) : null}
      <div className="breadcrumb">
        <Link href="/dashboard">
          {localized(locale, "工作台", "Workbench")}
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
              "選擇維護現有 SHOPLINE 商品、建立參考資料或建立新草稿。",
              "Choose maintenance of existing SHOPLINE products, reference intake or a new draft.",
            )}
          </p>
        </div>
      </div>
      <ListingIntakeChoices
        canScan={Boolean(session && session.role !== "viewer")}
        initialIntent={initialMaintenanceIntent(query)}
        reference={candidate?.success ? candidate.data : undefined}
        invalidReference={Boolean(candidate && !candidate.success)}
      />
    </div>
  );
}
