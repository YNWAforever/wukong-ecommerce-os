"use client";

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
      createdAt: string;
    };

// Mirrors packages/db/src/repositories/enrichment-batches.ts's
// EnrichmentBatchStatus union.
const BATCH_STATUS_LABELS: Record<string, string> = {
  open: "開放中 Open",
  running: "進行中 Running",
  completed: "已完成 Completed",
  budget_exhausted: "預算用盡 Budget exhausted",
  cancelled: "已取消 Cancelled",
};

// Mirrors packages/db/src/repositories/export-attempts.ts's
// ExportManifestOutcome union.
const EXPORT_OUTCOME_LABELS: Record<string, string> = {
  included: "已納入 Included",
  excluded_no_op: "無變更，未納入 Excluded, no changes",
  excluded_stale: "來源已過時，未納入 Excluded, stale source",
  not_import_origin: "非匯入來源，未納入 Excluded, not import-origin",
  raw_row_invalid: "來源資料無效，未納入 Excluded, invalid source row",
  listing_not_found: "找不到商品，未納入 Excluded, listing not found",
};

// Covers the audit actions confirmed to be written with entityId ===
// <listingId>, so they're the ones that can genuinely appear in this panel.
// See packages/core/src/workflow.ts, packages/core/src/compliance.ts, and
// packages/db/src/repositories/listings.ts for the write sites.
const AUDIT_ACTION_LABELS: Record<string, string> = {
  "listing.imported": "已匯入 Imported",
  "listing.import_refreshed": "匯入內容已更新 Import refreshed",
  "listing.approved": "已批准 Approved",
  "listing.published": "已發佈 Published",
  "listing.publish_failed": "發佈失敗 Publish failed",
  "listing.bulk_export_created": "已加入批量匯出 Included in bulk export",
  "listing.review_conflict": "審核衝突 Review conflict",
  "compliance.flag_resolved": "合規標記已處理 Compliance flag resolved",
  "listing.transition": "狀態變更 Status changed",
};

function humanizeAuditAction(action: string): string {
  return action.replace(/[._]/g, " ");
}

function summarize(entry: ActivityPanelEntry): string {
  switch (entry.kind) {
    case "audit":
      return (
        AUDIT_ACTION_LABELS[entry.action] ?? humanizeAuditAction(entry.action)
      );
    case "batch": {
      const status = BATCH_STATUS_LABELS[entry.status] ?? entry.status;
      return `批次 Batch: ${entry.label} (${status})`;
    }
    case "export": {
      const outcome = EXPORT_OUTCOME_LABELS[entry.outcome] ?? entry.outcome;
      return entry.reason
        ? `匯出 Export: ${outcome} (${entry.reason})`
        : `匯出 Export: ${outcome}`;
    }
  }
}

export function ActivityPanel({ entries }: { entries: ActivityPanelEntry[] }) {
  return (
    <section className="activity-panel" aria-labelledby="activity-heading">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">
            活動記錄 <span>ACTIVITY</span>
          </p>
          <h2 id="activity-heading">此商品的完整記錄 / Activity</h2>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="helper-copy" role="status">
          尚無活動記錄。 <span>No activity yet.</span>
        </p>
      ) : (
        <ul className="flag-list">
          {entries.map((entry) => {
            const createdAt = new Date(entry.createdAt);
            return (
              <li className="flag-item" key={`${entry.kind}:${entry.id}`}>
                <div className="flag-content">
                  <p>{summarize(entry)}</p>
                  <div className="jobs-row-meta">
                    <time dateTime={createdAt.toISOString()}>
                      {createdAt.toISOString()}
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
