import { BatchesClient } from "../../../components/batches-client";

export default function BatchesPage() {
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            Attended batches <span>ENRICHMENT WORKFLOW</span>
          </p>
          <h1>批次進度與新批次建立</h1>
          <p className="lede">
            查看現有批次的進度與花費，或針對特定內容缺口建立新的批次。
          </p>
        </div>
      </div>
      <BatchesClient />
    </div>
  );
}
