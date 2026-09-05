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
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const canStart =
    status === "received" && enqueueState !== "queued" && canProcess;

  let title: string;
  let explanation: string;

  if (status === "received" && enqueueState === "queued") {
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
    title = t("AI 處理未完成", "Processing failed");
    explanation = t(
      "來源檔案已保留，請聯絡支援人員協助安全復原。",
      "Source files are retained. Contact support for safe recovery.",
    );
  }

  return (
    <section className="panel processing-panel" aria-busy={busy}>
      <p className="eyebrow">{t("商品處理", "Listing processing")}</p>
      <h1>{title}</h1>
      <p className="lede">{explanation}</p>
      {canStart ? (
        <button type="button" onClick={onProcess} disabled={busy}>
          {busy
            ? commonCopy[locale].loading
            : t("開始處理", "Start processing")}
        </button>
      ) : null}
    </section>
  );
}
