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

const STATUS_COPY: Record<
  BatchSummary["status"],
  { label: string; english: string; className: string }
> = {
  open: { label: "待開始", english: "Open", className: "status-neutral" },
  running: { label: "進行中", english: "Running", className: "status-neutral" },
  completed: {
    label: "已完成",
    english: "Completed",
    className: "status-success",
  },
  budget_exhausted: {
    label: "預算用盡",
    english: "Budget exhausted",
    className: "status-danger",
  },
  cancelled: {
    label: "已取消",
    english: "Cancelled",
    className: "status-danger",
  },
};

// Only the insufficient_role code the GET route throws directly
// (apps/web/app/api/enrichment-batches/route.ts). Generic route-support.ts
// fallbacks (unauthorized, invalid_request, authentication_unavailable,
// internal_error, ...) are not mapped here, same as create-batch-form.tsx and
// advance-batch-button.tsx: they fall back to the server-provided message.
const API_ERROR_MESSAGES: Record<string, string> = {
  insufficient_role: "Operator access is required.",
};

const UNREACHABLE = "Could not reach the server. Try again.";

export function BatchList() {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let response: Response;
      try {
        response = await fetch("/api/enrichment-batches");
      } catch {
        if (!cancelled) setError(UNREACHABLE);
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        // A non-JSON body reaches here from a platform-level failure (e.g. a
        // 502/504/524 gateway page) rather than the application itself, same
        // as create-batch-form.tsx/advance-batch-button.tsx.
        if (!cancelled) setError(UNREACHABLE);
        return;
      }

      if (!response.ok) {
        const code =
          typeof body.code === "string" ? body.code : "unknown_error";
        const message =
          API_ERROR_MESSAGES[code] ??
          (typeof body.message === "string"
            ? body.message
            : "The batch list could not be loaded.");
        if (!cancelled) setError(message);
        return;
      }

      if (!cancelled) setBatches((body as { batches: BatchSummary[] }).batches);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p className="inline-warning" role="alert">
        {error}
      </p>
    );
  }
  if (batches === null) {
    return <p className="intake-message">載入中…</p>;
  }
  if (batches.length === 0) {
    return <p className="intake-message">尚無批次紀錄。</p>;
  }

  return (
    <ul className="file-list">
      {batches.map((batch) => {
        const status = STATUS_COPY[batch.status];
        return (
          <li key={batch.id}>
            <Link href={`/batches/${batch.id}`}>{batch.label}</Link>{" "}
            <span className={`batch-status ${status.className}`}>
              <span aria-hidden="true" />
              {status.label}
              <small>{status.english}</small>
            </span>{" "}
            · 每波 {batch.waveSize} · 預算 ${batch.budgetUsd}
          </li>
        );
      })}
    </ul>
  );
}
