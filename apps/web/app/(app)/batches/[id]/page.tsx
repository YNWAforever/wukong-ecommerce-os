import { cookies } from "next/headers";
import Link from "next/link";

import { BatchDetail } from "../../../../components/batch-detail";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { localized } from "../../../../lib/ui-copy";

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );

  return (
    <div className="page-wrap narrow-page">
      <div className="breadcrumb">
        <Link href="/batches">{localized(locale, "批次", "Batches")}</Link>
        <span aria-hidden="true">/</span>
        <span>{id}</span>
      </div>
      <div className="page-header">
        <div>
          {/*
            The page had no h1 at all, and BatchDetail opens at h2, so the
            document started one level down. This title is static and
            server-rendered, so it is present at first paint rather than
            appearing only once the batch loads.
          */}
          <h1>{localized(locale, "批次詳情", "Batch detail")}</h1>
        </div>
      </div>
      <BatchDetail batchId={id} />
    </div>
  );
}
