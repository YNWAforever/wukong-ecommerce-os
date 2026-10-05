"use client";
import {
  EXPORT_CONTENT_FIELDS,
  type ExportContentField,
  type ExportPreview,
  type ExportRepair,
} from "../lib/bulk-export-contract";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  commonCopy,
  formatNumber,
  stateLabel,
  safeUiError,
} from "../lib/ui-copy";
import {
  outcomeLabel,
  manifestReasonLabel,
  exportErrorLabel,
} from "../lib/export-ui-copy";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ExportReconciliationPanel,
  type WireExportReconciliationDetail,
} from "./export-reconciliation-panel";

/**
 * Stands in for a row's `contentDigest` when the catalog contract has it as
 * `null` (a linked row can have no recorded digest yet). Never a valid
 * sha256 row digest (wrong length/alphabet), so attesting it can never
 * accidentally match a real one -- the server's freshness check reports
 * `row_digest_mismatch` for that one listing instead of failing the whole
 * request's schema validation the way an empty string would.
 *
 * Only for a row whose digest has genuinely never been recorded. It must
 * never stand in for a digest a caller simply failed to look up (e.g. a
 * selected row that scrolled off the currently fetched catalog page) --
 * that use fabricated an attestation for content the operator was never
 * shown and silently excluded a perfectly current listing from its export.
 * `catalog-control-center.tsx` captures the digest a row had at the moment
 * it was selected instead, precisely so it never needs this sentinel for
 * that case.
 */
const exportFieldLabels: Record<ExportContentField, [string, string]> = {
  nameZh: ["中文名稱", "Chinese name"],
  summaryEn: ["英文摘要", "English summary"],
  summaryZh: ["中文摘要", "Chinese summary"],
  seoTitleEn: ["英文 SEO 標題", "English SEO title"],
  seoTitleZh: ["中文 SEO 標題", "Chinese SEO title"],
  seoDescriptionEn: ["英文 SEO 描述", "English SEO description"],
  seoDescriptionZh: ["中文 SEO 描述", "Chinese SEO description"],
  seoKeywords: ["SEO 關鍵字", "SEO keywords"],
};

export const NO_CONTENT_DIGEST = "no-content-digest-recorded";

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
  code?: string;
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

/**
 * What the operator attested, not merely which rows they picked.
 *
 * This joined ids alone, so when the catalog refreshed and a row's digest
 * changed beneath an unchanged selection, the tick survived over content
 * nobody had looked at. Folding the digests in drops the attestation exactly
 * when what was shown stops being true.
 */
function selectionIdentity(
  listings: ReadonlyArray<{ listingId: string; contentDigest: string }>,
): string {
  return [...listings]
    .map((entry) => `${entry.listingId}:${entry.contentDigest}`)
    .sort()
    .join("\u001f");
}

export function BulkExportPanel({
  listings,
  canGenerate,
  repair,
}: {
  listings: ReadonlyArray<{ listingId: string; contentDigest: string }>;
  canGenerate: boolean;
  repair?: ExportRepair;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const errorId = useId();
  const listingIds = listings.map((entry) => entry.listingId);
  const currentSelection = useMemo(
    () => selectionIdentity(listings),
    [listings],
  );
  const [fields, setFields] = useState<ExportContentField[]>([]);
  const contextIdentity = JSON.stringify([
    currentSelection,
    fields,
    canGenerate,
    repair ?? null,
  ]);
  const currentContext = useRef(contextIdentity);
  currentContext.current = contextIdentity;
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [reviewedPreview, setReviewedPreview] = useState<{
    identity: string;
    value: ExportPreview;
  } | null>(null);
  const preview =
    reviewedPreview?.identity === contextIdentity
      ? reviewedPreview.value
      : null;
  const [attestedSelection, setAttestedSelection] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server `code` behind the current `error`, kept separately so the
  // render can look up specific copy for it (e.g. `attestation_incomplete`)
  // without leaking `message` -- see `exportErrorLabel`. Cleared whenever a
  // new attempt starts or a differently-caused error replaces this one, so a
  // stale code from an earlier failure never mislabels a later one.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResponse | null>(null);
  const [detail, setDetail] = useState<WireExportReconciliationDetail | null>(
    null,
  );
  const inFlight = useRef(false);
  const detailSequence = useRef(0);
  useEffect(() => {
    detailSequence.current += 1;
    setResult(null);
    setDetail(null);
    setDetailBusy(false);
    setError(null);
    setErrorCode(null);
  }, [contextIdentity]);
  const attested =
    currentSelection.length > 0 && attestedSelection === currentSelection;

  async function loadDetail(attemptId: string) {
    const identity = currentContext.current;
    const sequence = ++detailSequence.current;
    const isCurrent = () =>
      active.current &&
      currentContext.current === identity &&
      detailSequence.current === sequence;
    setDetailBusy(true);
    try {
      const response = await fetch(`/api/listings/export/${attemptId}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Unable to load export status (${response.status})`);
      const loaded = (await response.json()) as WireExportReconciliationDetail;
      if (!isCurrent()) return;
      setDetail(loaded);
      setError(null);
      setErrorCode(null);
    } catch (caught) {
      if (!isCurrent()) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load export status",
      );
      setErrorCode(null);
    } finally {
      if (isCurrent()) setDetailBusy(false);
    }
  }

  async function reviewPreview() {
    if (
      inFlight.current ||
      !canGenerate ||
      !attested ||
      !fields.length ||
      !listingIds.length
    )
      return;
    const identity = contextIdentity;
    const submitted = {
      listingIds: listings.map((listing) => listing.listingId),
      fields: [...fields],
      attestation: { listings: [...listings] },
      ...(repair ? { repair } : {}),
    };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setReviewedPreview(null);
    try {
      const response = await fetch("/api/listings/export/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submitted),
      });
      const body = await response.json();
      if (!active.current || currentContext.current !== identity) return;
      if (!response.ok) {
        setErrorCode(body.code ?? null);
        throw new Error("Unable to preview export");
      }
      if (
        !/^[a-f0-9]{64}$/.test(body.previewSha256) ||
        !Array.isArray(body.changes) ||
        !Array.isArray(body.manifest) ||
        !Array.isArray(body.fields)
      )
        throw new Error("Incomplete export preview");
      setReviewedPreview({ identity, value: body as ExportPreview });
    } catch (caught) {
      if (active.current && currentContext.current === identity)
        setError(
          caught instanceof Error ? caught.message : "Unable to preview export",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function generate() {
    if (
      inFlight.current ||
      !canGenerate ||
      !attested ||
      !preview ||
      listingIds.length === 0
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setResult(null);
    setDetail(null);
    // Both arrays below are derived from this one snapshot, taken once, so
    // `submittedIds` and the attested listings can never name different
    // selections -- there is no separate `listingIds` capture that could
    // drift from what gets attested.
    const identity = contextIdentity;
    const submittedFields = [...fields];
    const submittedPreview = preview.previewSha256;
    const submittedListings = [...listings];
    const submittedIds = submittedListings.map((entry) => entry.listingId);
    try {
      const response = await fetch("/api/listings/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listingIds: submittedIds,
          fields: submittedFields,
          previewSha256: submittedPreview,
          ...(repair ? { repair } : {}),
          attestation: { listings: submittedListings },
        }),
      });
      const body = (await response.json()) as ExportResponse;
      if (!active.current || currentContext.current !== identity) return;
      if (!response.ok) {
        if (body.exportAttemptId) {
          setResult(body);
          await loadDetail(body.exportAttemptId);
          return;
        }
        // Forward the `code` only, never `message` -- the server's message
        // can describe internals this UI must not surface. `exportErrorLabel`
        // maps a recognised code to copy; the thrown message below is a
        // fixed, made-up string (never the server's), kept only as a
        // fallback for a code the render's lookup does not recognise.
        setErrorCode(body.code ?? null);
        setReviewedPreview(null);
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
      if (!active.current || currentContext.current !== identity) return;
      setError(
        caught instanceof Error ? caught.message : "Unable to generate export",
      );
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
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
      <fieldset data-export-fields disabled={busy || !canGenerate}>
        <legend>
          {t("選擇本次 XLSX 更新欄位", "Choose fields for this XLSX")}
        </legend>
        {EXPORT_CONTENT_FIELDS.map((field) => {
          return (
            <label key={field}>
              <input
                type="checkbox"
                value={field}
                checked={fields.includes(field)}
                onChange={(event) => {
                  setFields((current) =>
                    EXPORT_CONTENT_FIELDS.filter((key) =>
                      key === field
                        ? event.target.checked
                        : current.includes(key),
                    ),
                  );
                  setReviewedPreview(null);
                }}
              />
              {t(...exportFieldLabels[field])}
            </label>
          );
        })}
      </fieldset>
      <p className="helper-copy">
        {t(
          "只更新所選內容欄；其他欄位保留，庫存增減指令歸零。",
          "Only selected copy fields change. Other cells are preserved; stock delta instructions are neutralized.",
        )}
      </p>
      {preview ? (
        <section aria-label={t("XLSX 更新預覽", "XLSX update preview")}>
          <p>
            {t("納入商品：", "Included listings:")} {preview.rowCount} ·{" "}
            {t("選中欄位：", "Selected fields:")}{" "}
            {preview.fields
              .map((field) => t(...exportFieldLabels[field]))
              .join(", ")}
          </p>
          <ul>
            {preview.manifest.map((member) => (
              <li key={member.listingId}>
                {member.listingId} · {outcomeLabel(member.outcome, locale)}
                {member.reason
                  ? " · " +
                    manifestReasonLabel(member.reason, member.outcome, locale)
                  : ""}
              </li>
            ))}
          </ul>
          <ul>
            {preview.changes.map((change) => (
              <li key={change.listingId + change.column}>
                {change.listingId} · {t(...exportFieldLabels[change.column])}:{" "}
                {change.from ?? t("空白", "Blank")} → {change.to} ·{" "}
                {t("來源", "Source")} {change.sourceSnapshotId} ·{" "}
                {t("批准版本", "Approved version")} {change.versionId}
              </li>
            ))}
          </ul>
          {preview.neutralizedQuantityDeltas.length ? (
            <p>
              {t(
                "庫存增減指令將歸零：",
                "Stock delta instructions will be neutralized:",
              )}{" "}
              {preview.neutralizedQuantityDeltas.join(", ")}
            </p>
          ) : null}
        </section>
      ) : null}
      <button
        className="primary-button"
        type="button"
        disabled={
          !canGenerate ||
          !attested ||
          !fields.length ||
          listingIds.length === 0 ||
          busy
        }
        aria-describedby={error ? errorId : undefined}
        onClick={() => void (preview ? generate() : reviewPreview())}
      >
        {busy
          ? t("正在產生…", "Generating…")
          : preview
            ? t("確認預覽並產生 XLSX", "Generate Bulk Update XLSX")
            : t("預覽批量更新 XLSX", "Preview Bulk Update XLSX")}
      </button>
      {preview ? (
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void reviewPreview()}
        >
          {t("重新預覽", "Preview again")}
        </button>
      ) : null}
      {!canGenerate ? (
        <p className="helper-copy">
          {t("需要審核員權限。", "Reviewer access required.")}
        </p>
      ) : null}
      {error ? (
        <p className="inline-warning" role="alert" id={errorId}>
          {exportErrorLabel(errorCode ?? undefined, locale) ??
            safeUiError(
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
