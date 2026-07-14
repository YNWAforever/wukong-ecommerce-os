import type { Evidence } from "./listing-view-models";

export type EvidencePanelProps = {
  evidence: Array<Evidence & { field: string }>;
  activeField?: string | null;
};

export function EvidencePanel({ evidence, activeField }: EvidencePanelProps) {
  const visibleEvidence = activeField ? evidence.filter((entry) => entry.field === activeField) : evidence;

  return (
    <aside className="evidence-panel" aria-labelledby="evidence-heading">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">證據 <span>EVIDENCE</span></p>
          <h2 id="evidence-heading">來源依據</h2>
        </div>
        <span className="verified-pill">已保存</span>
      </div>
      <p className="panel-intro">每個事實欄位都保留來源摘錄，方便你快速核對。</p>
      {visibleEvidence.length > 0 ? (
        <ol className="evidence-list">
          {visibleEvidence.map((entry, index) => (
            <li key={`${entry.field}-${entry.source}-${index}`} className="evidence-item">
              <div className="evidence-meta"><span>{entry.field}</span><span>{entry.source}{entry.page ? ` · 第 ${entry.page} 頁` : ""}</span></div>
              <blockquote>「{entry.excerpt}」</blockquote>
            </li>
          ))}
        </ol>
      ) : <p className="empty-state">尚未有來源摘錄 <span>No source excerpt</span></p>}
    </aside>
  );
}
