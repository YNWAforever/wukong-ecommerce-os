"use client";
import {
  APPROVAL_INVALIDATED_ACTION,
  isApprovalInvalidationCause,
  type ApprovalInvalidationCause,
} from "@wukong/core";
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
  [APPROVAL_INVALIDATED_ACTION]: ["批准已失效", "Approval invalidated"],
  "compliance.flag_resolved": ["合規標記已處理", "Compliance flag resolved"],
  "listing.transition": ["狀態變更", "Status changed"],
};

const invalidationCauses: Record<
  ApprovalInvalidationCause,
  readonly [string, string]
> = {
  confirmation_changed: ["確認內容已變更", "Confirmations changed"],
  source_reimported_changed: [
    "重新匯入，來源資料已變更",
    "Re-imported with changed source row",
  ],
  source_reimported_unchanged: [
    "重新匯入，來源資料未變",
    "Re-imported, row unchanged",
  ],
};

function causeOf(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const cause = (metadata as { cause?: unknown }).cause;
  return typeof cause === "string" ? cause : undefined;
}
function summarize(
  entry: ActivityPanelEntry,
  locale: ReturnType<typeof useLocale>,
): string {
  const t = (zh: string, en: string) => localized(locale, zh, en);
  if (entry.kind === "audit") {
    const action = auditActions[entry.action];
    if (!action) return t("其他活動記錄", "Other activity");
    const label = localized(locale, ...action);
    const causeKey =
      entry.action === APPROVAL_INVALIDATED_ACTION
        ? causeOf(entry.metadata)
        : undefined;
    const cause =
      causeKey !== undefined &&
      Object.hasOwn(invalidationCauses, causeKey) &&
      isApprovalInvalidationCause(causeKey)
        ? invalidationCauses[causeKey]
        : undefined;
    // An unknown cause shows the label alone rather than a raw enum value.
    return cause ? label + " (" + localized(locale, ...cause) + ")" : label;
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
