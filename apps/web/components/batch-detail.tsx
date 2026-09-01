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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function BatchDetail({ batchId }: { batchId: string }) {
  const [data, setData] = useState<BatchDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `signal` is only supplied by the effect below, which re-runs (aborting
  // any still-in-flight request first) whenever `batchId` changes. Without
  // it, a slow response for a stale batchId could resolve after a newer
  // request and overwrite `data`/`error` with the wrong batch's content — a
  // real race, since Next.js App Router commonly reuses this same component
  // instance across client navigations between two /batches/[id] URLs
  // instead of remounting it. The imperative call from AdvanceBatchButton's
  // onAdvanced is a one-shot user-triggered refresh, not a re-render, so it
  // intentionally omits the signal.
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      let response: Response;
      try {
        response = await fetch(`/api/enrichment-batches/${batchId}`, {
          signal,
        });
      } catch (cause) {
        if (isAbortError(cause)) return;
        setError(UNREACHABLE);
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch (cause) {
        // A non-JSON body reaches here from a platform-level failure (e.g. a
        // 502/504/524 gateway page) rather than the application itself, same
        // as batch-list.tsx/advance-batch-button.tsx.
        if (isAbortError(cause)) return;
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
    },
    [batchId],
  );

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
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
