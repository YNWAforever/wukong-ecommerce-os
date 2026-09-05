import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import { readPageCopy } from "../../../lib/read-page-copy";
import { commonCopy } from "../../../lib/ui-copy";
import { JobsLedgerClient } from "../../../components/jobs-ledger-client";

export default async function JobsPage() {
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const copy = readPageCopy.jobs[locale];
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="lede">{copy.description}</p>
        </div>
      </div>
      <JobsLedgerClient />
    </div>
  );
}
