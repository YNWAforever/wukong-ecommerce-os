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
  // `failed` is offered too, because the server already supports it:
  // POST /api/listings/[id]/process accepts received/needs_info/failed, and
  // pipelineRuns.reopenFailed deletes the still-running step rows before
  // re-enqueueing, so a retry starts clean rather than colliding with the
  // lease the failed run left behind.
  //
  // `needs_info` is offered as well, now that a re-run carries its own
  // attempt number. Its run completed with status `succeeded`, so before that
  // the same route answered 409 processing_already_started no matter what the
  // operator supplied, and this button would only have failed.
  const canStart =
    (status === "received" ||
      status === "failed" ||
      status === "needs_info") &&
    enqueueState !== "queued" &&
    canProcess;

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
    title = t("AI 處理未完成", "Processing did not finish");
    explanation = t(
      "來源檔案已保留，沒有內容被覆寫。你可以再處理一次。",
      "Your source files are kept and nothing was overwritten. You can run processing again.",
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
            : status === "failed" || status === "needs_info"
              ? t("再處理一次", "Run processing again")
              : t("開始處理", "Start processing")}
        </button>
      ) : null}
    </section>
  );
}
