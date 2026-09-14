import { cookies } from "next/headers";

import { BatchesClient } from "../../../components/batches-client";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import { localized } from "../../../lib/ui-copy";

export default async function BatchesPage() {
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );

  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            {localized(locale, "隨行批次", "Attended batches")}
          </p>
          <h1>
            {localized(
              locale,
              "批次進度與新批次建立",
              "Batch progress and new batches",
            )}
          </h1>
          <p className="lede">
            {localized(
              locale,
              "查看現有批次的進度與花費，或針對特定內容缺口建立新的批次。",
              "Review the progress and spend of existing batches, or create one for a specific content gap.",
            )}
          </p>
        </div>
      </div>
      <BatchesClient />
    </div>
  );
}
