import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { getDatabase } from "../../../lib/intake-runtime";
import {
  LOCALE_COOKIE_NAME,
  resolveLocale,
  type Locale,
} from "../../../lib/locale";
import { resolveOpsOperator } from "../../../lib/ops-access";
import { formatHkDate, localized } from "../../../lib/ui-copy";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Pilot leads · Wukong",
  robots: { index: false, follow: false },
};

const skuVolumeLabels: Record<string, readonly [string, string]> = {
  under_100: ["少於 100", "Under 100"],
  "100_500": ["100–500", "100–500"],
  "500_2000": ["500–2,000", "500–2,000"],
  over_2000: ["超過 2,000", "Over 2,000"],
};

function skuVolume(locale: Locale, value: string | null) {
  if (!value) return localized(locale, "未提供", "not provided");
  const label = skuVolumeLabels[value];
  return label ? localized(locale, ...label) : value;
}

/**
 * Internal, read-only pilot-lead inbox.
 *
 * This page is outside the `(app)` route group on purpose: an operator does not
 * need a workspace membership, and a tenant must never reach another merchant's
 * sales lead through its admin area. Access is the exact-email allowlist in
 * `OPS_LEAD_EMAILS`; an absent list denies everyone. The SQL in
 * `docs/runbooks/pilot-lead-intake.md` remains the fallback.
 */
export default async function OpsPilotLeadsPage() {
  const operator = await resolveOpsOperator();
  if (!operator) notFound();

  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const leads = await getDatabase().listPilotLeads({ limit: 100 });
  console.info(
    JSON.stringify({ event: "ops_pilot_leads_viewed", count: leads.length }),
  );

  return (
    <main className="page-wrap ops-leads-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">{t("內部", "Internal")}</p>
          <h1>{t("先導計劃申請", "Pilot leads")}</h1>
          <p className="lede">
            {t(
              "只讀列表，最多顯示最近 100 個申請。此頁只限內部營運人員，不會向商戶工作區公開。",
              "Read-only list of the latest 100 requests. This page is limited to internal operators and is never exposed to a merchant workspace.",
            )}
          </p>
        </div>
      </header>

      {leads.length === 0 ? (
        <section className="card">
          <p>{t("暫時沒有先導計劃申請。", "No pilot requests yet.")}</p>
        </section>
      ) : (
        <section className="card">
          <div className="ops-leads-table-wrap">
            <table
              className="members-table ops-leads-table"
              aria-label={t("先導計劃申請列表", "Pilot lead list")}
            >
              <thead>
                <tr>
                  <th scope="col">{t("收到時間", "Received")}</th>
                  <th scope="col">{t("聯絡人", "Contact")}</th>
                  <th scope="col">{t("公司", "Company")}</th>
                  <th scope="col">{t("平台", "Platforms")}</th>
                  <th scope="col">{t("SKU 數量", "SKU volume")}</th>
                  <th scope="col">{t("語言 / 來源", "Locale / source")}</th>
                  <th scope="col">{t("訊息", "Message")}</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <time dateTime={lead.createdAt.toISOString()}>
                        {formatHkDate(lead.createdAt, locale)}
                      </time>
                      <span className="ops-lead-meta">
                        {t("同意於", "Consented")}{" "}
                        {formatHkDate(lead.consentAt, locale)}
                      </span>
                    </td>
                    <td className="ops-lead-contact">
                      <strong>{lead.name}</strong>
                      <a href={`mailto:${lead.email}`}>{lead.email}</a>
                    </td>
                    <td>{lead.company}</td>
                    <td>
                      {lead.platforms.length > 0
                        ? lead.platforms.join(", ")
                        : t("未提供", "not provided")}
                    </td>
                    <td>{skuVolume(locale, lead.skuVolume)}</td>
                    <td>
                      {lead.locale}
                      <span className="ops-lead-meta">{lead.source}</span>
                    </td>
                    <td className="ops-lead-message">
                      {lead.message ?? t("未提供", "not provided")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
