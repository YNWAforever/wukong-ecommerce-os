"use client";
import { evidenceFieldLabel } from "../lib/review-ui-copy";
import { useLocale } from "../lib/locale-context";
import { localized, formatNumber } from "../lib/ui-copy";

import type { Evidence } from "./listing-view-models";

export type EvidencePanelProps = {
  evidence: Array<Evidence & { field: string }>;
  activeField?: string | null;
};

export function EvidencePanel({ evidence, activeField }: EvidencePanelProps) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const visibleEvidence = activeField
    ? evidence.filter((entry) => entry.field === activeField)
    : evidence;

  return (
    <aside className="evidence-panel" aria-labelledby="evidence-heading">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">{t("證據", "Evidence")}</p>
          <h2 id="evidence-heading">{t("來源依據", "Source evidence")}</h2>
        </div>
        <span className="verified-pill">{t("已保存", "Retained")}</span>
      </div>
      <p className="panel-intro">
        {t(
          "每個事實欄位都保留來源摘錄，方便你快速核對。",
          "Source excerpts are retained for checking each factual field.",
        )}
      </p>
      {visibleEvidence.length > 0 ? (
        <ol className="evidence-list">
          {visibleEvidence.map((entry, index) => (
            <li
              key={`${entry.field}-${entry.source}-${index}`}
              className="evidence-item"
            >
              <div className="evidence-meta">
                <span>{evidenceFieldLabel(entry.field, locale)}</span>
                <span>
                  {entry.source}
                  {entry.page
                    ? ` · ${t("頁", "Page")} ${formatNumber(entry.page, locale)}`
                    : ""}
                </span>
              </div>
              <blockquote>「{entry.excerpt}」</blockquote>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-state">
          {t("尚未有來源摘錄", "No source excerpt")}
        </p>
      )}
    </aside>
  );
}
