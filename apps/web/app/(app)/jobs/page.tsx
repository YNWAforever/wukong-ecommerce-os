import { JobsLedgerClient } from "../../../components/jobs-ledger-client";

export default function JobsPage() {
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            Jobs ledger <span>ECOMMERCE OS CONTROL PLANE</span>
          </p>
          <h1>批次、發佈、AI 流程與匯出，一頁掌握所有內部作業。</h1>
          <p className="lede">
            查看批次任務、發佈工作、AI
            處理流程與匯出紀錄的最新狀態，快速找出卡住或失敗的作業。
          </p>
        </div>
      </div>
      <JobsLedgerClient />
    </div>
  );
}
