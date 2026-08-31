"use client";

import { useCallback, useEffect, useState } from "react";

import { AdvanceBatchButton } from "./advance-batch-button";

type BatchDetailData = {
  batch: {
    id: string;
    label: string;
    budgetUsd: number;
    waveSize: number;
    status: string;
    createdBy: string;
    createdAt: string;
  };
  counts: {
    pending: number;
    queued: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
};

// Only the ApiError codes the GET route and its service throw directly
// (apps/web/app/api/enrichment-batches/[id]/route.ts,
// apps/web/lib/enrichment-batch-service.ts#getBatch). Generic
// route-support.ts fallbacks (unauthorized, invalid_request,
// authentication_unavailable, internal_error, ...) are not mapped here, same
// as batch-list.tsx and advance-batch-button.tsx: they fall back to the
// server-provided message.
const API_ERROR_MESSAGES: Record<string, string> = {
  insufficient_role: "Operator access is required.",
  batch_not_found: "This batch no longer exists.",
};

const UNREACHABLE = "Could not reach the server. Try again.";

export function BatchDetail({ batchId }: { batchId: string }) {
  const [data, setData] = useState<BatchDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    let response: Response;
    try {
      response = await fetch(`/api/enrichment-batches/${batchId}`);
    } catch {
      setError(UNREACHABLE);
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // A non-JSON body reaches here from a platform-level failure (e.g. a
      // 502/504/524 gateway page) rather than the application itself, same
      // as batch-list.tsx/advance-batch-button.tsx.
      setError(UNREACHABLE);
      return;
    }

    if (!response.ok) {
      const code =
        typeof body.code === "string" ? body.code : "unknown_error";
      const message =
        API_ERROR_MESSAGES[code] ??
        (typeof body.message === "string"
          ? body.message
          : "The batch could not be loaded.");
      setError(message);
      return;
    }

    setError(null);
    setData(body as unknown as BatchDetailData);
  }, [batchId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (error) {
    return (
      <p className="inline-warning" role="alert">
        {error}
      </p>
    );
  }
  if (data === null) {
    return <p className="intake-message">載入中…</p>;
  }

  return (
    <div>
      <h2>{data.batch.label}</h2>
      <p>
        狀態: {data.batch.status} · 每波 {data.batch.waveSize} · 預算 $
        {data.batch.budgetUsd}
      </p>
      <ul className="file-list">
        <li>pending: {data.counts.pending}</li>
        <li>queued: {data.counts.queued}</li>
        <li>succeeded: {data.counts.succeeded}</li>
        <li>failed: {data.counts.failed}</li>
        <li>skipped: {data.counts.skipped}</li>
      </ul>
      <AdvanceBatchButton batchId={batchId} onAdvanced={() => void reload()} />
    </div>
  );
}
