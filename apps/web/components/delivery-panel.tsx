"use client";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";

import type { DeliveryModel } from "./listing-view-models";
import { BulkExportPanel } from "./bulk-export-panel";
import { ImportResultForm, ImportResultHistory } from "./import-result-form";
import { useState } from "react";

export type { DeliveryModel } from "./listing-view-models";

type DeliveryPanelProps = {
  model: DeliveryModel;
  sku?: string | null;
  onCsv?: () => void;
  onPublish?: () => void;
  onResultRecorded?: () => void | Promise<void>;
};

const connectionCopy: Record<
  DeliveryModel["connection"],
  { label: string; english: string; className: string; detail: string }
> = {
  disconnected: {
    label: "未連接",
    english: "Not connected",
    className: "status-neutral",
    detail: "尚未設定 SHOPLINE 連接。你仍可匯出 CSV 作為 fallback。",
  },
  error: {
    label: "連接錯誤",
    english: "Connection error",
    className: "status-danger",
    detail: "連接未通過驗證。請修正設定後再嘗試發布。",
  },
  connected: {
    label: "已連接",
    english: "Connected",
    className: "status-success",
    detail: "SHOPLINE 連接已驗證，可在批准後發布。",
  },
};

export function DeliveryPanel({
  model,
  sku = null,
  onCsv,
  onPublish,
  onResultRecorded,
}: DeliveryPanelProps) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const connection = connectionCopy[model.connection];
  const [showHistorical, setShowHistorical] = useState(false);
  const imported = model.shoplineLink?.origin === "import";
  const supportsCreateDelivery =
    model.shoplineLink === null || model.shoplineLink.origin === "created";
  const approved = model.status === "approved" || model.status === "published";
  const canDeliver = approved && model.canReview;
  const canApiPublish =
    supportsCreateDelivery &&
    canDeliver &&
    model.connection === "connected" &&
    model.status === "approved";
  const csvEnabled = supportsCreateDelivery && canDeliver;

  return (
    <section className="delivery-panel" aria-labelledby="delivery-heading">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">{t("交付", "Delivery")}</p>
          <h2 id="delivery-heading">{t("上架方式", "Delivery methods")}</h2>
        </div>
        <span className={`connection-status ${connection.className}`}>
          <span aria-hidden="true" />
          {t(connection.label, connection.english)}
        </span>
      </div>
      <p className="panel-intro">
        {t(
          connection.detail,
          model.connection === "connected"
            ? "The SHOPLINE connection is configured for delivery after approval."
            : model.connection === "error"
              ? "Connection validation failed. Check settings before retrying."
              : "SHOPLINE is not connected. Create CSV remains a fallback for eligible listings.",
        )}
      </p>
      {supportsCreateDelivery ? (
        <div className="delivery-actions">
          <button
            className="primary-button"
            type="button"
            onClick={onPublish}
            disabled={!canApiPublish}
          >
            {model.shoplineLink
              ? t("透過 API 更新至 SHOPLINE", "Update via API")
              : t("透過 API 建立至 SHOPLINE", "Create via API")}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={onCsv}
            disabled={!csvEnabled}
          >
            {t("匯出 SHOPLINE 建立 CSV", "Create CSV · CSV fallback")}
          </button>
        </div>
      ) : null}
      {!approved ? (
        <p className="helper-copy">
          {t("批准版本後才能交付。", "Approval is required before delivery.")}
        </p>
      ) : null}
      {!model.canReview ? (
        <p className="helper-copy">
          {t("需要審核員或管理員權限才能交付。", "Reviewer access required.")}
        </p>
      ) : null}
      {canApiPublish ? (
        model.shoplineLink ? (
          <p className="helper-copy">
            {t(
              "此操作將更新現有 SHOPLINE 商品",
              "This will update the existing SHOPLINE product",
            )}
            {sku ? ` (${sku})` : ""}.
          </p>
        ) : (
          <p className="helper-copy">
            {t(
              "此操作將建立新的 SHOPLINE 商品。",
              "This will create a new SHOPLINE product.",
            )}
          </p>
        )
      ) : null}
      {imported && model.listingId ? (
        <BulkExportPanel
          listingIds={[model.listingId]}
          canGenerate={model.canReview}
        />
      ) : null}
      {!imported && model.shoplineLink ? (
        <p className="helper-copy">
          {t(
            "此商品由系統建立，請使用建立 CSV 或 API 交付。批量更新 XLSX 需要匯入來源資料列。",
            "Created-origin listing: use Create CSV / API delivery actions. Bulk Update XLSX requires an imported source row.",
          )}
        </p>
      ) : null}
      {model.listingId && model.canRecordImportResult ? (
        <div className="historical-report">
          <button
            type="button"
            className="secondary-button"
            aria-expanded={showHistorical}
            onClick={() => setShowHistorical((value) => !value)}
          >
            {t("記錄未連結的歷史結果", "Record unlinked historical result")}
          </button>
          {showHistorical ? (
            <>
              <p className="helper-copy">
                {t(
                  "手動歷史回報 — 未連結，不能用作完成匯出結果對帳。",
                  "Manual historical report — unlinked. It cannot close an export reconciliation total.",
                )}
              </p>
              <ImportResultHistory
                label={t("手動更正記錄", "Manual correction history")}
                results={model.historicalImportResults ?? []}
              />
              <ImportResultForm
                listingId={model.listingId}
                mode="historical_manual"
                latestResult={model.historicalImportResults?.[0] ?? null}
                onRecorded={onResultRecorded}
              />
            </>
          ) : null}
        </div>
      ) : null}
      {model.remoteProductId ? (
        <p className="remote-link">
          {t("SHOPLINE 商品 ID", "SHOPLINE product ID")}{" "}
          <code>{model.remoteProductId}</code>
        </p>
      ) : null}
      {model.remoteProductUrl ? (
        <p className="remote-link">
          <a href={model.remoteProductUrl} rel="noreferrer">
            {t("查看 SHOPLINE 商品", "View remote product")} →
          </a>
        </p>
      ) : null}
    </section>
  );
}
