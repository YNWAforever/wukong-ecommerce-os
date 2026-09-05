import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import { readPageCopy } from "../../../lib/read-page-copy";
import { commonCopy } from "../../../lib/ui-copy";
import { QualitySummaryClient } from "../../../components/quality-summary-client";

// Deliberately no role gate here (matches /jobs's and /system-map's
// precedent) -- /quality is open to any authenticated workspace member.
export default async function QualityPage() {
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const copy = readPageCopy.quality[locale];
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="lede">{copy.description}</p>
        </div>
      </div>
      <QualitySummaryClient />
    </div>
  );
}
