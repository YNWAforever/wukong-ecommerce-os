import type { ListingStatus } from "@wukong/core";

type ProcessingStatus = Extract<
  ListingStatus,
  "received" | "processing" | "needs_info" | "failed"
>;

type ListingProcessingPanelProps = {
  status: ProcessingStatus;
  enqueueState?: "queued" | "retry_required";
  canProcess: boolean;
  onProcess: () => void | Promise<void>;
  busy: boolean;
};

export function ListingProcessingPanel({
  status,
  enqueueState,
  canProcess,
  onProcess,
  busy,
}: ListingProcessingPanelProps) {
  const canStart =
    status === "received" && enqueueState !== "queued" && canProcess;

  let title: string;
  let explanation: string;

  if (status === "received" && enqueueState === "queued") {
    title = "已加入處理佇列 · Queued for processing";
    explanation = "AI 工作程序將在可用時開始處理。";
  } else if (status === "received") {
    title = "尚未開始處理 · Processing not started";
    explanation = "商品資料已儲存；你可以重新開始 AI 處理。";
  } else if (status === "processing") {
    title = "AI 正在建立商品資料 · AI processing";
    explanation = "正在整理來源、建立雙語內容及檢查合規要求。";
  } else if (status === "needs_info") {
    title = "需要補充商品資料 · More information needed";
    explanation = "請補充或核對缺少的商品資料，再繼續審核。";
  } else {
    title = "AI 處理未完成 · Processing failed";
    explanation = "來源檔案已保留，請聯絡支援人員協助安全復原。";
  }

  return (
    <section className="panel processing-panel" aria-busy={busy}>
      <p className="eyebrow">商品處理 · LISTING PROCESSING</p>
      <h1>{title}</h1>
      <p className="lede">{explanation}</p>
      {canStart ? (
        <button type="button" onClick={onProcess} disabled={busy}>
          開始處理 · Start processing
        </button>
      ) : null}
    </section>
  );
}
