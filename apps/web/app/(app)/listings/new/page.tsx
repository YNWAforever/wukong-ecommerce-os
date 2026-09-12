import { cookies } from "next/headers";
import Link from "next/link";

import { ListingIntakeClient } from "../../../../components/listing-intake-client";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { localized } from "../../../../lib/ui-copy";

export default async function NewListingPage() {
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );

  return (
    <div className="page-wrap narrow-page">
      <div className="breadcrumb">
        <Link href="/dashboard">
          {localized(locale, "工作台", "Workbench")}
        </Link>
        <span aria-hidden="true">/</span>
        <span>{localized(locale, "建立草稿", "New listing")}</span>
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">
            {localized(locale, "資料匯入", "Listing intake")}
          </p>
          <h1>{localized(locale, "建立上架草稿", "Create a listing draft")}</h1>
          <p className="lede">
            {localized(
              locale,
              "上傳瓶身圖片與供應商資料，AI 會整理成可核對的商品欄位。",
              "Upload bottle photos and supplier material, and the AI arranges them into product fields you can check.",
            )}
          </p>
        </div>
        <div className="step-indicator">
          <span className="step-current">01</span>
          <span>{localized(locale, "資料", "Intake")}</span>
          <span className="step-line" />
          <span>02</span>
          <span>{localized(locale, "審核", "Review")}</span>
          <span className="step-line" />
          <span>03</span>
          <span>{localized(locale, "交付", "Delivery")}</span>
        </div>
      </div>
      <ListingIntakeClient />
    </div>
  );
}
