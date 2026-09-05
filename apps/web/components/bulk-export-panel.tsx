"use client";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  commonCopy,
  formatNumber,
  stateLabel,
  safeUiError,
} from "../lib/ui-copy";
import { outcomeLabel, manifestReasonLabel } from "../lib/export-ui-copy";

import { useId, useMemo, useRef, useState } from "react";
import {
  ExportReconciliationPanel,
  type WireExportReconciliationDetail,
} from "./export-reconciliation-panel";

type ExportResponse = {
  exportAttemptId: string | null;
  artifactStatus?: "pending" | "ready" | "failed";
  manifest?: Array<{
    listingId: string;
    versionId: string | null;
    outcome: string;
    reason?: string;
  }>;
  rowCount?: number;
  message?: string;
};

function isCompletedZeroRowResponse(
  response: ExportResponse,
): response is ExportResponse & {
  exportAttemptId: null;
  rowCount: 0;
  manifest: NonNullable<ExportResponse["manifest"]>;
} {
  return (
    response.exportAttemptId === null &&
    response.rowCount === 0 &&
    Array.isArray(response.manifest)
  );
}

function selectionIdentity(listingIds: readonly string[]): string {
  return [...listingIds].sort().join("\u001f");
}

export function BulkExportPanel({
  listingIds,
  canGenerate,
}: {
  listingIds: readonly string[];
  canGenerate: boolean;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const errorId = useId();
  const currentSelection = useMemo(
    () => selectionIdentity(listingIds),
    [listingIds],
  );
  const [attestedSelection, setAttestedSelection] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResponse | null>(null);
  const [detail, setDetail] = useState<WireExportReconciliationDetail | null>(
    null,
  );
  const inFlight = useRef(false);
  const attested =
    currentSelection.length > 0 && attestedSelection === currentSelection;

  async function loadDetail(attemptId: string) {
    setDetailBusy(true);
    try {
      const response = await fetch(`/api/listings/export/${attemptId}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Unable to load export status (${response.status})`);
      setDetail((await response.json()) as WireExportReconciliationDetail);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load export status",
      );
    } finally {
      setDetailBusy(false);
    }
  }

  async function generate() {
    if (
      inFlight.current ||
      !canGenerate ||
      !attested ||
      listingIds.length === 0
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    setDetail(null);
    const submittedIds = [...listingIds];
    try {
      const response = await fetch("/api/listings/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listingIds: submittedIds,
          freshnessAttested: true,
        }),
      });
      const body = (await response.json()) as ExportResponse;
      if (!response.ok) {
        if (body.exportAttemptId) {
          setResult(body);
          await loadDetail(body.exportAttemptId);
          return;
        }
        throw new Error(`Unable to generate export (${response.status})`);
      }
      if (body.exportAttemptId) {
        setResult(body);
        await loadDetail(body.exportAttemptId);
      } else if (isCompletedZeroRowResponse(body)) {
        setResult(body);
      } else {
        throw new Error(
          "The export response was incomplete; retry the export.",
        );
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to generate export",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const completedZeroRow =
    result && isCompletedZeroRowResponse(result) ? result : null;
  const completedCounts = completedZeroRow
    ? {
        requested: completedZeroRow.manifest.length,
        included: completedZeroRow.manifest.filter(
          (item) => item.outcome === "included",
        ).length,
        noOp: completedZeroRow.manifest.filter(
          (item) => item.outcome === "excluded_no_op",
        ).length,
      }
    : null;
  const excludedCount = completedCounts
    ? completedCounts.requested -
      completedCounts.included -
      completedCounts.noOp
    : 0;

  return (
    <section
      className="bulk-export-panel"
      aria-label={t("批量更新 XLSX 匯出", "Bulk Update XLSX export")}
      aria-busy={busy || detailBusy}
    >
      <p>
        <strong>{formatNumber(listingIds.length, locale)}</strong>{" "}
        {t("項商品已選取作本次匯出。", "listing(s) selected for this export.")}
      </p>
      <label className="freshness-attestation">
        <input
          type="checkbox"
          checked={attested}
          onChange={(event) =>
            setAttestedSelection(event.target.checked ? currentSelection : null)
          }
        />{" "}
        {t(
          "我確認此 SHOPLINE 來源匯出仍為最新版本。",
          "I confirm this SHOPLINE source export is still current.",
        )}
      </label>
      <button
        className="primary-button"
        type="button"
        disabled={!canGenerate || !attested || listingIds.length === 0 || busy}
        aria-describedby={error ? errorId : undefined}
        onClick={() => void generate()}
      >
        {busy
          ? t("正在產生…", "Generating…")
          : t("產生批量更新 XLSX", "Generate Bulk Update XLSX")}
      </button>
      {!canGenerate ? (
        <p className="helper-copy">
          {t("需要審核員權限。", "Reviewer access required.")}
        </p>
      ) : null}
      {error ? (
        <p className="inline-warning" role="alert" id={errorId}>
          {safeUiError(
            error,
            locale,
            result?.exportAttemptId ? "read" : "action",
          )}
        </p>
      ) : null}
      {result?.exportAttemptId && !detail ? (
        <article
          className="reconciliation-panel"
          data-export-attempt-id={result.exportAttemptId}
        >
          <h3>
            {t("批量更新 XLSX 匯出記錄", "Bulk Update XLSX export attempt")}
          </h3>
          <p className="jobs-row-meta">
            {t("匯出記錄", "Attempt")} <code>{result.exportAttemptId}</code>
          </p>
          <p>
            {t("檔案狀態：", "Artifact status:")}{" "}
            {stateLabel(result.artifactStatus ?? "pending", locale)}
          </p>
          <button
            className="secondary-button"
            type="button"
            disabled={detailBusy}
            onClick={() => void loadDetail(result.exportAttemptId!)}
          >
            {detailBusy
              ? commonCopy[locale].loading
              : t("重試載入匯出記錄", "Retry attempt details")}
          </button>
        </article>
      ) : null}
      {completedZeroRow && completedCounts ? (
        <div className="manifest-summary" data-zero-row-export-summary>
          <h3>
            {t("批量更新 XLSX 匯出已完成", "Bulk Update XLSX export completed")}
          </h3>
          <p>
            {t(
              "所有選取商品均被排除或沒有變更，因此未建立檔案。",
              "No artifact was created because every requested listing was excluded or unchanged.",
            )}
          </p>
          <p>
            {t("要求", "Requested")}:{" "}
            {formatNumber(completedCounts.requested, locale)} ·{" "}
            {t("納入", "Included")}:{" "}
            {formatNumber(completedCounts.included, locale)} ·{" "}
            {t("排除", "Excluded")}: {formatNumber(excludedCount, locale)} ·{" "}
            {t("無變更", "No-op")}: {formatNumber(completedCounts.noOp, locale)}
          </p>
          <ul>
            {completedZeroRow.manifest.map((item) => (
              <li key={item.listingId} data-listing-id={item.listingId}>
                {t("商品", "Listing")} <code>{item.listingId}</code> ·{" "}
                {t("版本", "Version")}{" "}
                <code>{item.versionId ?? commonCopy[locale].unavailable}</code>{" "}
                · {t("結果", "Outcome")}{" "}
                <code>{outcomeLabel(item.outcome, locale)}</code> ·{" "}
                {t("原因", "Reason")}{" "}
                {manifestReasonLabel(item.reason, item.outcome, locale)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail ? <ExportReconciliationPanel detail={detail} /> : null}
    </section>
  );
}
