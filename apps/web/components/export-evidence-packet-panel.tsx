"use client";
import { useEffect, useRef, useState } from "react";
import type { ExportEvidenceSummary } from "../lib/export-evidence-service";
import { useLocale } from "../lib/locale-context";
import { localized, formatHkDate } from "../lib/ui-copy";

export function ExportEvidencePacketPanel({
  attemptId,
  comparisonId,
  eligible = true,
}: {
  attemptId: string;
  comparisonId: string;
  eligible?: boolean;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [preview, setPreview] = useState<ExportEvidenceSummary | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [blocked, setBlocked] = useState(false);
  const generation = useRef(0),
    inFlight = useRef(false),
    urls = useRef(new Set<string>());
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setPreview(null);
    setBusy(false);
    setError("");
    setBlocked(false);
    return () => {
      generation.current++;
      inFlight.current = false;
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, [attemptId, comparisonId, eligible]);
  const endpoint = `/api/listings/export/${encodeURIComponent(attemptId)}/evidence-packet`;
  async function request(download: boolean) {
    if (!eligible || blocked || inFlight.current || (download && !preview))
      return;
    const token = generation.current;
    const current = () => token === generation.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    if (!download) setPreview(null);
    try {
      const response = download
        ? await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
              comparisonId,
              expectedSnapshotSha256: preview!.snapshotSha256,
            }),
          })
        : await fetch(`${endpoint}?${new URLSearchParams({ comparisonId })}`, {
            cache: "no-store",
          });
      if (!current()) return;
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          code?: string;
        };
        if (!current()) return;
        if (failure.code === "export_artifact_not_ready") {
          setPreview(null);
          setBlocked(true);
          setError(
            t(
              "檔案尚未準備好。請重新載入頁面。",
              "Artifact is not ready. Reload the page.",
            ),
          );
          return;
        }
        if (response.status === 409) {
          setPreview(null);
          setError(
            t(
              "證據已變更或無法使用。請重新整理預覽並檢閱後再下載。",
              "Evidence changed or is unavailable. Refresh the preview and review it before downloading.",
            ),
          );
        } else if ([401, 403, 404].includes(response.status)) {
          setPreview(null);
          setBlocked(true);
          setError(
            t(
              "證據無法存取。請重新載入頁面以確認權限及檔案狀態。",
              "Evidence is inaccessible. Reload the page to check access and artifact readiness.",
            ),
          );
        } else {
          if (response.status !== 503) setPreview(null);
          setError(
            t(
              "未能準備證據。選擇已保留，請重試。",
              "Evidence could not be prepared. Selection is retained. Please retry.",
            ),
          );
        }
        return;
      }
      if (!download) {
        const body = (await response.json()) as ExportEvidenceSummary;
        if (!current()) return;
        if (
          body.exportAttemptId !== attemptId ||
          body.comparisonId !== comparisonId ||
          !/^[a-f0-9]{64}$/.test(body.snapshotSha256)
        )
          throw new Error("identity");
        setPreview(body);
      } else {
        const blob = await response.blob();
        if (!current()) return;
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `export-${attemptId}-comparison-${comparisonId}-evidence.json`;
        document.body.append(anchor);
        try {
          anchor.click();
        } finally {
          anchor.remove();
          setTimeout(() => {
            if (urls.current.delete(url)) URL.revokeObjectURL(url);
          }, 1000);
        }
      }
    } catch {
      if (current())
        setError(
          t(
            "未能準備證據。選擇已保留，請重試。",
            "Evidence could not be prepared. Selection is retained. Please retry.",
          ),
        );
    } finally {
      if (current()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  if (!eligible) return null;
  const counts: Record<string, string> = {
    expected: t("預期商品", "Expected products"),
    matched: t("相符商品", "Matched products"),
    differences: t("差異商品", "Products with differences"),
    missing: t("缺少商品", "Missing products"),
    ambiguous: t("重複 ID", "Ambiguous IDs"),
    unsupportedVariant: t("不支援變體", "Unsupported variants"),
    unrelatedRows: t("無關資料列", "Unrelated rows"),
    suppliedRows: t("提供資料列", "Supplied rows"),
  };
  return (
    <section
      className="export-evidence-packet-panel"
      aria-label={t("證據資料包", "Evidence packet")}
    >
      <h4>{t("證據資料包", "Evidence packet")}</h4>
      {!blocked && (
        <div className="evidence-packet-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void request(false)}
          >
            {t("預覽證據資料包", "Preview evidence packet")}
          </button>
          <button
            type="button"
            className="secondary-button"
            data-download-evidence
            disabled={busy || !preview}
            onClick={() => void request(true)}
          >
            {t("下載證據 JSON", "Download evidence JSON")}
          </button>
        </div>
      )}
      {busy && <p role="status">{t("準備中…", "Preparing…")}</p>}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div data-evidence-preview={preview.comparisonId}>
          <p>
            {t("匯出嘗試 ID", "Export attempt ID")}:{" "}
            <code>{preview.exportAttemptId}</code>
            <br />
            {t("比較 ID", "Comparison ID")}: <code>{preview.comparisonId}</code>
            <br />
            {t("資料截至", "As of")}: {formatHkDate(preview.asOf, locale)}
          </p>
          <dl className="reconciliation-counts">
            {[
              [t("包括商品", "Included members"), preview.memberCount],
              [
                t("回報修訂", "Receipt revisions"),
                preview.receiptRevisionCount,
              ],
              [
                t("已回報商品", "Reported members"),
                preview.reportedMemberCount,
              ],
              [
                t("未回報商品", "Unreported members"),
                preview.unreportedMemberCount,
              ],
              ...Object.entries(preview.comparisonCounts).map(
                ([key, value]) => [counts[key] ?? key, value],
              ),
              [t("JSON 位元組", "JSON bytes"), preview.byteLength],
            ].map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p>
            {t("比較結果", "Comparison outcome")}:{" "}
            {preview.comparisonOutcome === "matches_compared_fields"
              ? t("已比較欄位相符", "Matches compared fields")
              : preview.comparisonOutcome === "differences_found"
                ? t("發現差異", "Differences found")
                : t("未能確定", "Inconclusive")}
          </p>
          <p>
            {t("檔案 SHA-256", "Artifact SHA-256")}:{" "}
            <code>{preview.artifactSha256}</code>
            <br />
            {t("提供快照 SHA-256", "Supplied snapshot SHA-256")}:{" "}
            <code>{preview.suppliedSha256}</code>
            <br />
            {t("證據快照 SHA-256", "Evidence snapshot SHA-256")}:{" "}
            <code>{preview.snapshotSha256}</code>
          </p>
          <p>
            {t(
              "所提供快照；商店及時間由操作員聲明。僅包含標準化儲存格證據；庫存增減只屬觀察。並非經驗證的 SHOPLINE 即時狀態，亦不聲稱成因或庫存不變。",
              "Supplied snapshot; store and time operator-attested. Normalized cells only; quantity deltas are observational. No authenticated live SHOPLINE state, causality or stock-neutrality claim.",
            )}
          </p>
          <p>
            {t(
              "並非 UAT 簽核或商家寫入授權。下載不會變更工作流程狀態。",
              "Not a UAT sign-off or merchant-write authorization. Download does not change workflow state.",
            )}
          </p>
        </div>
      )}
    </section>
  );
}
