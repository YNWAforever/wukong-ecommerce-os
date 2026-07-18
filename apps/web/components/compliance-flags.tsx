"use client";

import { useState } from "react";

import type { BlockingFlag } from "./listing-view-models";

type ComplianceFlagsProps = {
  flags: BlockingFlag[];
  canResolve?: boolean;
  onResolve?: (flagId: string, reason: string) => Promise<void> | void;
};

export function ComplianceFlags({
  flags,
  canResolve = false,
  onResolve,
}: ComplianceFlagsProps) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (flags.length === 0)
    return (
      <p className="success-note" role="status">
        沒有需要處理的合規提示 <span>No open compliance flags</span>
      </p>
    );

  async function resolve(flag: BlockingFlag) {
    const reason = (reasons[flag.id] ?? "").trim();
    if (reason.length < 10) {
      setError("處理理由至少需要 10 個字元。");
      return;
    }
    setError(null);
    setPendingId(flag.id);
    try {
      await onResolve?.(flag.id, reason);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="flags" aria-labelledby="flags-heading">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">
            合規提示 <span>COMPLIANCE</span>
          </p>
          <h2 id="flags-heading">批准前需要處理</h2>
        </div>
        <span className="flag-count">
          {flags.filter((flag) => flag.status === "open").length} 項開放
        </span>
      </div>
      {error ? (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="flag-list">
        {flags.map((flag) => (
          <li className={`flag-item flag-${flag.status}`} key={flag.id}>
            <div className="flag-marker" aria-hidden="true" />
            <div className="flag-content">
              <h3>{flag.label}</h3>
              <p>{flag.description}</p>
              <span className="flag-status">
                {flag.status === "open" ? "待處理 · Open" : "已處理 · Resolved"}
              </span>
              {flag.status === "resolved" && flag.resolutionReason ? (
                <p className="helper-copy">處理理由：{flag.resolutionReason}</p>
              ) : null}
              {flag.status === "open" && canResolve && onResolve ? (
                <div className="flag-resolution">
                  <label htmlFor={`flag-reason-${flag.id}`}>處理理由</label>
                  <textarea
                    id={`flag-reason-${flag.id}`}
                    value={reasons[flag.id] ?? ""}
                    minLength={10}
                    maxLength={1000}
                    rows={3}
                    placeholder="請記錄核對結果或修改內容（至少 10 個字元）"
                    onChange={(event) =>
                      setReasons((current) => ({
                        ...current,
                        [flag.id]: event.target.value,
                      }))
                    }
                  />
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={pendingId === flag.id}
                    onClick={() => void resolve(flag)}
                  >
                    標記為已處理 <span>Resolve flag</span>
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
