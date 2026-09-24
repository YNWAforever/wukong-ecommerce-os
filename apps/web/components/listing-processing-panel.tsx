"use client";
import { useLocale } from "../lib/locale-context";
import { localized, commonCopy } from "../lib/ui-copy";

import type { ListingStatus } from "@wukong/core";

type ProcessingStatus = Extract<
  ListingStatus,
  "received" | "processing" | "needs_info" | "failed"
>;

type ListingProcessingPanelProps = {
  status: ProcessingStatus;
  errorCode?: string | null;
  enqueueState?: "queued" | "retry_required";
  canProcess: boolean;
  onProcess: () => void | Promise<void>;
  busy: boolean;
};

export function ListingProcessingPanel({
  status,
  errorCode,
  enqueueState,
  canProcess,
  onProcess,
  busy,
}: ListingProcessingPanelProps) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  // An explicit retry creates a new immutable operation.
  const canStart =
    (status === "received" || status === "failed" || status === "needs_info") &&
    enqueueState !== "queued" &&
    canProcess;

  let title: string;
  let explanation: string;

  if (enqueueState === "queued") {
    title = t("已加入處理佇列", "Queued for processing");
    explanation = t(
      "AI 工作程序將在可用時開始處理。",
      "AI processing will start when a worker is available.",
    );
  } else if (status === "received") {
    title = t("尚未開始處理", "Processing not started");
    explanation = t(
      "商品資料已儲存；你可以重新開始 AI 處理。",
      "Listing data is saved. You can start AI processing again.",
    );
  } else if (status === "processing") {
    title = t("AI 正在建立商品資料", "AI processing");
    explanation = t(
      "正在整理來源、建立雙語內容及檢查合規要求。",
      "Organizing sources, drafting bilingual content and checking compliance.",
    );
  } else if (status === "needs_info") {
    title = t("需要補充商品資料", "More information needed");
    explanation = t(
      "請補充或核對缺少的商品資料，再繼續審核。",
      "Add or check missing listing information before continuing review.",
    );
  } else {
    title = t("AI 處理未完成", "Processing did not finish");
    explanation = t(
      "相片及已儲存資料仍然保留。你可以重試 AI，或在下方手動填寫並儲存草稿。",
      "Your photos and saved work are retained. Retry AI or complete and save the draft manually below.",
    );
  }

  return (
    <section className="panel processing-panel" aria-busy={busy}>
      <p className="eyebrow">{t("商品處理", "Listing processing")}</p>
      <h1>{title}</h1>
      <p className="lede">{explanation}</p>
      {errorCode === "missing_configuration" ||
      errorCode === "ai_configuration_required" ? (
        <p role="status">
          {t(
            "AI 設定尚未完成。你仍可儲存及手動完成草稿。",
            "AI setup needs attention. You can still save and complete the draft manually.",
          )}
        </p>
      ) : errorCode === "invalid_media" ||
        errorCode === "provider_capability" ? (
        <p role="status">
          {t(
            "請檢查相片，或將不支援的檔案標記為僅供參考並手動輸入資料。",
            "Check the photos, or mark unsupported files as reference-only and enter their facts manually.",
          )}
        </p>
      ) : errorCode === "rate_limited" ? (
        <p role="status">
          {t(
            "AI 服務暫時限流。稍後可建立新的重試。",
            "The AI service is rate-limited. You can start a new retry later.",
          )}
        </p>
      ) : errorCode === "budget_blocked" ? (
        <p role="status">
          {t(
            "AI 預算已用盡。你仍可手動儲存草稿。",
            "The AI budget is exhausted. Manual saving is still available.",
          )}
        </p>
      ) : null}
      {canStart ? (
        <button type="button" onClick={onProcess} disabled={busy}>
          {busy
            ? commonCopy[locale].loading
            : status === "failed" || status === "needs_info"
              ? t("再處理一次", "Run processing again")
              : t("開始處理", "Start processing")}
        </button>
      ) : null}
    </section>
  );
}
