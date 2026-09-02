"use client";

export type ActivityPanelEntry =
  | {
      kind: "audit";
      id: string;
      action: string;
      metadata: unknown;
      createdAt: string;
    }
  | { kind: "batch"; id: string; label: string; status: string; createdAt: string }
  | {
      kind: "export";
      id: string;
      outcome: string;
      reason?: string;
      createdAt: string;
    };

function summarize(entry: ActivityPanelEntry): string {
  switch (entry.kind) {
    case "audit":
      return entry.action;
    case "batch":
      return `批次 Batch: ${entry.label} (${entry.status})`;
    case "export":
      return entry.reason
        ? `匯出 Export: ${entry.outcome} (${entry.reason})`
        : `匯出 Export: ${entry.outcome}`;
  }
}

export function ActivityPanel({
  entries,
}: {
  entries: ActivityPanelEntry[];
}) {
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
        <p className="helper-copy">
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
