"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type BatchSummary = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: "open" | "running" | "completed" | "budget_exhausted" | "cancelled";
  createdBy: string;
  createdAt: string;
};

const STATUS_TONE: Record<
  BatchSummary["status"],
  "status-neutral" | "status-success" | "status-danger"
> = {
  open: "status-neutral",
  running: "status-neutral",
  completed: "status-success",
  budget_exhausted: "status-danger",
  cancelled: "status-danger",
};

export function BatchList() {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/enrichment-batches")
      .then((response) => response.json())
      .then((body: { batches: BatchSummary[] }) => {
        if (!cancelled) setBatches(body.batches);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (batches === null) {
    return <p className="intake-message">載入中…</p>;
  }
  if (batches.length === 0) {
    return <p className="intake-message">尚無批次紀錄。</p>;
  }

  return (
    <ul className="file-list">
      {batches.map((batch) => (
        <li key={batch.id}>
          <Link href={`/batches/${batch.id}`}>{batch.label}</Link>{" "}
          <span className={`batch-status ${STATUS_TONE[batch.status]}`}>
            <span />
            {batch.status}
          </span>{" "}
          · 每波 {batch.waveSize} · 預算 ${batch.budgetUsd}
        </li>
      ))}
    </ul>
  );
}
