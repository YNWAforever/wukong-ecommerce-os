"use client";

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
          <p className="eyebrow">
            交付 <span>DELIVERY</span>
          </p>
          <h2 id="delivery-heading">上架方式</h2>
        </div>
        <span className={`connection-status ${connection.className}`}>
          <span aria-hidden="true" />
          {connection.label}
          <small>{connection.english}</small>
        </span>
      </div>
      <p className="panel-intro">{connection.detail}</p>
      {supportsCreateDelivery ? (
        <div className="delivery-actions">
          <button
            className="primary-button"
            type="button"
            onClick={onPublish}
            disabled={!canApiPublish}
          >
            發布至 SHOPLINE{" "}
            {model.shoplineLink ? (
              <span>Update via API</span>
            ) : (
              <span>Create via API</span>
            )}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={onCsv}
            disabled={!csvEnabled}
          >
            匯出 SHOPLINE CSV <span>Create CSV · CSV fallback</span>
          </button>
        </div>
      ) : null}
      {!approved ? (
        <p className="helper-copy">
          批准版本後才能交付。{" "}
          <span>Approval is required before delivery.</span>
        </p>
      ) : null}
      {!model.canReview ? (
        <p className="helper-copy">
          需要審核員或管理員權限才能交付。{" "}
          <span>Reviewer access required.</span>
        </p>
      ) : null}
      {canApiPublish ? (
        model.shoplineLink ? (
          <p className="helper-copy">
            此操作將更新現有 SHOPLINE 商品{sku ? `「${sku}」` : ""}。{" "}
            <span>
              This will update the existing SHOPLINE product
              {sku ? ` for ${sku}` : ""}.
            </span>
          </p>
        ) : (
          <p className="helper-copy">
            此操作將建立新的 SHOPLINE 商品。{" "}
            <span>This will create a new SHOPLINE product.</span>
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
          Created-origin listing: use Create CSV / API delivery actions. Bulk
          Update XLSX requires an imported source row.
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
            Record unlinked historical result
          </button>
          {showHistorical ? (
            <>
              <p className="helper-copy">
                Manual historical report — unlinked. It cannot close an export
                reconciliation total.
              </p>
              <ImportResultHistory
                label="Manual correction history"
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
          SHOPLINE product ID <code>{model.remoteProductId}</code>
        </p>
      ) : null}
      {model.remoteProductUrl ? (
        <p className="remote-link">
          <a href={model.remoteProductUrl} rel="noreferrer">
            查看 SHOPLINE 商品 <span>View remote product</span> →
          </a>
        </p>
      ) : null}
    </section>
  );
}
