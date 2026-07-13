import type { BlockingFlag } from "./listing-view-models";

export function ComplianceFlags({ flags }: { flags: BlockingFlag[] }) {
  if (flags.length === 0) return <p className="success-note" role="status">沒有需要處理的合規提示 <span>No open compliance flags</span></p>;

  return (
    <section className="flags" aria-labelledby="flags-heading">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">合規提示 <span>COMPLIANCE</span></p>
          <h2 id="flags-heading">批准前需要處理</h2>
        </div>
        <span className="flag-count">{flags.filter((flag) => flag.status === "open").length} 項開放</span>
      </div>
      <ul className="flag-list">
        {flags.map((flag) => (
          <li className={`flag-item flag-${flag.status}`} key={flag.code}>
            <div className="flag-marker" aria-hidden="true" />
            <div>
              <h3>{flag.label}</h3>
              <p>{flag.description}</p>
              <span className="flag-status">{flag.status === "open" ? "待處理 · Open" : "已處理 · Resolved"}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
