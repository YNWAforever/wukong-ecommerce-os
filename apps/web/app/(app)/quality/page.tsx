import { QualitySummaryClient } from "../../../components/quality-summary-client";

// Deliberately no role gate here (matches /jobs's and /system-map's
// precedent) -- /quality is open to any authenticated workspace member.
export default function QualityPage() {
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            Quality <span>ECOMMERCE OS CONTROL PLANE</span>
          </p>
          <h1>內容品質總覽，誠實反映目前內容。</h1>
          <p className="lede">
            六項內容缺口訊號與 AI
            總成本，皆根據商品目前的實際內容計算，而非匯入當下的舊快照。
          </p>
        </div>
      </div>
      <QualitySummaryClient />
    </div>
  );
}
