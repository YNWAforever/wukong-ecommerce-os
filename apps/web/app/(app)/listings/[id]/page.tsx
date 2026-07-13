import Link from "next/link";

import { ComplianceFlags } from "../../../../components/compliance-flags";
import { DeliveryPanel } from "../../../../components/delivery-panel";
import { EvidencePanel } from "../../../../components/evidence-panel";
import { ListingFieldsForm } from "../../../../components/listing-fields-form";
import { fallbackReviewModel } from "../../../../components/listing-view-models";

export default async function ListingReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const model = { ...fallbackReviewModel, id };
  const evidence = model.fields.flatMap((field) => field.evidence ? [{ field: field.label, ...field.evidence }] : []);

  return (
    <div className="page-wrap review-page">
      <div className="breadcrumb"><Link href="/dashboard">工作台</Link><span aria-hidden="true">/</span><span>{model.title}</span></div>
      <div className="review-header">
        <div>
          <p className="eyebrow">商品審核 <span>LISTING REVIEW · {model.id}</span></p>
          <h1>{model.title}</h1>
          <p className="lede">確認 AI 建議、核對來源，然後交由審核員批准。</p>
        </div>
        <span className="review-status status-review"><span aria-hidden="true" />待審核 <small>In review</small></span>
      </div>
      <div className="review-layout">
        <EvidencePanel evidence={evidence} />
        <div className="review-content">
          <ListingFieldsForm model={model} />
          <ComplianceFlags flags={model.blockingFlags} />
          <DeliveryPanel model={{ connection: "disconnected", status: model.status, canReview: true, remoteProductUrl: null }} />
        </div>
      </div>
    </div>
  );
}
