"use client";
import type { WineProgress } from "../lib/wine-progress";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
export function WineEvidencePanel({
  evidence,
}: {
  evidence: WineProgress["evidence"];
}) {
  const locale = useLocale(),
    t = (zh: string, en: string) => localized(locale, zh, en);
  return (
    <details className="panel">
      <summary>
        {t("查看原始資料及來源", "Inspect original evidence and sources")} (
        {evidence.length})
      </summary>
      {!evidence.length && (
        <p>{t("尚未有已儲存的來源。", "No persisted evidence yet.")}</p>
      )}
      {evidence.map((source) => (
        <article key={source.id}>
          <h3>{source.title}</h3>
          {source.kind === "merchant" &&
            source.title ===
              "Merchant identity selection (not observed evidence)" && (
              <p>
                {t(
                  "操作員確認：並非相片觀察或獨立網頁證據。",
                  "Operator confirmation: not a photo observation or independent web proof.",
                )}
              </p>
            )}
          <blockquote style={{ whiteSpace: "pre-wrap" }}>
            {source.excerpt}
          </blockquote>
          <p>
            {source.contentScope} ·{" "}
            <time dateTime={source.capturedAt}>{source.capturedAt}</time>
            {source.truncated && <> · {t("已截短", "Truncated")}</>}
          </p>
          {source.linkStatus === "available" && source.url ? (
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              {t("開啟原始文件", "Open original document")}
            </a>
          ) : (
            <p>
              {source.linkStatus === "unavailable"
                ? t("來源連結不可用", "Source link unavailable")
                : t("此來源不適用網頁連結", "No web link for this source")}
            </p>
          )}
        </article>
      ))}
    </details>
  );
}
