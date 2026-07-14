import Link from "next/link";

import { ListingQueue } from "../../../components/listing-queue";

export default function DashboardPage() {
  return (
    <div className="page-wrap">
      <div className="page-header dashboard-header">
        <div>
          <p className="eyebrow">Opak Cellar <span>OPAK PILOT WORKSPACE</span></p>
          <h1>早上好，今天先處理最接近上架的酒款。</h1>
          <p className="lede">AI 只提出有來源的建議；你保留最後的審核權。</p>
        </div>
        <Link className="primary-button" href="/listings/new">建立上架草稿 <span>Create draft</span></Link>
      </div>
      <div className="metric-strip" aria-label="工作台摘要">
        <div><span className="metric-value">5</span><span className="metric-label">進行中 <small>Active</small></span></div>
        <div><span className="metric-value">1</span><span className="metric-label">待你審核 <small>Needs review</small></span></div>
        <div><span className="metric-value">0</span><span className="metric-label">阻塞上架 <small>Blocked delivery</small></span></div>
      </div>
      <ListingQueue />
    </div>
  );
}
