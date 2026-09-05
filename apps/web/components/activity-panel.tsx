"use client";
import { useLocale } from "../lib/locale-context";
import { localized, formatHkDate, stateLabel } from "../lib/ui-copy";
import { outcomeLabel, manifestReasonLabel } from "../lib/export-ui-copy";

export type ActivityPanelEntry =
  | {
      kind: "audit";
      id: string;
      action: string;
      metadata: unknown;
      createdAt: string;
    }
  | {
      kind: "batch";
      id: string;
      label: string;
      status: string;
      createdAt: string;
    }
  | {
      kind: "export";
      id: string;
      outcome: string;
      reason?: string;
      artifactStatus?: string | null;
      provenanceComplete?: boolean;
      createdAt: string;
    };

const auditActions: Record<string, readonly [string, string]> = {
  "listing.imported": ["已匯入", "Imported"],
  "listing.import_refreshed": ["匯入內容已更新", "Import refreshed"],
  "listing.approved": ["已批准", "Approved"],
  "listing.published": ["已發佈", "Published"],
  "listing.publish_failed": ["發佈失敗", "Publish failed"],
  "listing.bulk_export_created": ["已加入批量匯出", "Included in bulk export"],
  "listing.review_conflict": ["審核衝突", "Review conflict"],
  "compliance.flag_resolved": ["合規標記已處理", "Compliance flag resolved"],
  "listing.transition": ["狀態變更", "Status changed"],
};
function summarize(
  entry: ActivityPanelEntry,
  locale: ReturnType<typeof useLocale>,
): string {
  const t = (zh: string, en: string) => localized(locale, zh, en);
  if (entry.kind === "audit") {
    const action = auditActions[entry.action];
    return action
      ? localized(locale, ...action)
      : t("其他活動記錄", "Other activity");
  }
  if (entry.kind === "batch")
    return (
      t("批次", "Batch") +
      ": " +
      entry.label +
      " (" +
      stateLabel(entry.status, locale) +
      ")"
    );
  const artifact =
    entry.provenanceComplete !== true
      ? t("歷史記錄；來源證據不完整", "historical; provenance incomplete")
      : stateLabel(entry.artifactStatus ?? "pending", locale);
  return (
    t("匯出", "Export") +
    ": " +
    outcomeLabel(entry.outcome, locale) +
    (entry.reason
      ? " (" + manifestReasonLabel(entry.reason, entry.outcome, locale) + ")"
      : "") +
    " (" +
    artifact +
    ")"
  );
}

export function ActivityPanel({ entries }: { entries: ActivityPanelEntry[] }) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  return (
    <section className="activity-panel" aria-labelledby="activity-heading">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">{t("活動記錄", "Activity")}</p>
          <h2 id="activity-heading">
            {t("此商品的完整記錄", "Listing activity")}
          </h2>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="helper-copy" role="status">
          {t("尚無活動記錄。", "No activity yet.")}
        </p>
      ) : (
        <ul className="flag-list">
          {entries.map((entry) => {
            return (
              <li className="flag-item" key={`${entry.kind}:${entry.id}`}>
                <div className="flag-content">
                  <p>{summarize(entry, locale)}</p>
                  <div className="jobs-row-meta">
                    <time dateTime={entry.createdAt}>
                      {formatHkDate(entry.createdAt, locale)}
                    </time>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
