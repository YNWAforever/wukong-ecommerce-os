import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import { localized } from "../../../lib/ui-copy";
import { CapabilityRegistryPanel } from "../../../components/capability-registry-panel";

// Deliberately no role gate here (unlike /admin/page.tsx's redirect for
// non-admins) -- /system-map is open to any authenticated workspace member,
// matching /jobs's and /catalog's existing precedent. Authentication (not
// authorization) is enforced by apps/web/middleware.ts's session-cookie
// check; CapabilityRegistryPanel itself has no role check baked in either.
export default async function SystemMapPage() {
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            {localized(locale, "系統能力", "System map")}
          </p>
          <h1>
            {localized(
              locale,
              "系統實作能力現況。",
              "Source implementation capabilities.",
            )}
          </h1>
          <p className="lede">
            {localized(
              locale,
              "已實作、試行中、規劃中或已封鎖，與管理區系統真相分頁共用同一份登記冊。正式操作狀態須另行驗證。",
              "Implemented, pilot, planned or blocked: the same registry used by the admin System Truth tab. Operational status requires separate verification.",
            )}
          </p>
        </div>
      </div>
      <CapabilityRegistryPanel />
    </div>
  );
}
