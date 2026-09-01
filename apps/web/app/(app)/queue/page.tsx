import { QueueClient } from "../../../components/queue-client";

export default function QueuePage() {
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            工作佇列 <span>WORK QUEUE</span>
          </p>
          <h1>依狀態排序的完整工作佇列</h1>
          <p className="lede">
            檢視所有進行中商品，並批量批准已符合條件的項目。
          </p>
        </div>
      </div>
      <QueueClient />
    </div>
  );
}
