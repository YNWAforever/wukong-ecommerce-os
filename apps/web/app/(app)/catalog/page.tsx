import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import { readPageCopy } from "../../../lib/read-page-copy";
import { commonCopy } from "../../../lib/ui-copy";
import Link from "next/link";

import { CatalogControlCenter } from "../../../components/catalog-control-center";

export default async function CatalogPage() {
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const copy = readPageCopy.catalog[locale];
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="lede">{copy.description}</p>
        </div>
        <Link className="primary-button" href="/listings/new">
          {commonCopy[locale].createDraft}
        </Link>
      </div>
      <CatalogControlCenter />
    </div>
  );
}
