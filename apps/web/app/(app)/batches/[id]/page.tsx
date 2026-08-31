import Link from "next/link";

import { BatchDetail } from "../../../../components/batch-detail";

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="page-wrap narrow-page">
      <div className="breadcrumb">
        <Link href="/batches">批次</Link>
        <span aria-hidden="true">/</span>
        <span>{id}</span>
      </div>
      <BatchDetail batchId={id} />
    </div>
  );
}
