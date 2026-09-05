"use client";

import { useCallback, useState } from "react";

import type {
  ListingCollectionItem,
  ListingReviewContext,
} from "../lib/dashboard-queue-shared";
import { mapDashboardItems } from "../lib/dashboard-queue-shared";
import { useLatestRequest } from "../lib/use-latest-request";
import { ListingQueue } from "./listing-queue";

type BulkApproveResultItem =
  | { listingId: string; ok: true; versionId: string }
  | { listingId: string; ok: false; code: string; message: string };

type BulkApproveResponse = {
  results: BulkApproveResultItem[];
  approved: number;
  failed: number;
};

function bulkErrorMessage(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof (body as { message: unknown }).message === "string"
  ) {
    return (body as { message: string }).message;
  }
  return "Bulk approve failed -- try again.";
}

export function QueueClient() {
  const [page, setPage] = useState(1);
  // Keep the context observed at selection, including after a partial-success
  // reload. Retrying a failed item must not silently approve refreshed data.
  const [selection, setSelection] = useState<Map<string, ListingReviewContext>>(
    new Map(),
  );
  const selected = new Set(selection.keys());
  const [bulkResult, setBulkResult] = useState<BulkApproveResponse | null>(
    null,
  );
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetch(`/api/listings?page=${page}&pageSize=100`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok)
        throw new Error(`Unable to load listings (${response.status})`);
      return (await response.json()) as {
        items: ListingCollectionItem[];
        totalMatching: number;
        page: number;
        pageSize: number;
      };
    },
    [page],
  );
  const { data, error, loading, stale, reload } = useLatestRequest(
    load,
    "Unable to load listings",
  );
  const items = data?.items ?? null;

  const toggleSelected = (id: string) => {
    setSelection((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else {
        const item = items?.find((candidate) => candidate.id === id);
        if (item?.reviewContext && current.size < 50) {
          next.set(id, { ...item.reviewContext });
        }
      }
      return next;
    });
  };

  const selectAllEligible = (eligibleIds: string[]) => {
    setSelection((current) => {
      const next = new Map(current);
      const itemsById = new Map(items?.map((item) => [item.id, item]));
      for (const id of eligibleIds) {
        if (next.has(id)) continue;
        if (next.size >= 50) break;
        const context = current.get(id) ?? itemsById.get(id)?.reviewContext;
        if (context) next.set(id, { ...context });
      }
      return next;
    });
  };

  const clearSelection = () => setSelection(new Map());

  const runBulkApprove = async () => {
    setBulkPending(true);
    setBulkResult(null);
    setBulkError(null);
    try {
      const response = await fetch("/api/listings/bulk-approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [...selection].map(([listingId, context]) => ({
            listingId,
            ...context,
          })),
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setBulkError(bulkErrorMessage(body));
        return;
      }
      const result = body as BulkApproveResponse;
      const approvedIds = new Set(
        result.results.filter((item) => item.ok).map((item) => item.listingId),
      );
      setBulkResult(result);
      setSelection((current) => {
        const next = new Map(current);
        for (const id of approvedIds) next.delete(id);
        return next;
      });
      reload();
    } catch {
      // Covers both a rejected fetch() call (network failure) and a thrown
      // response.json() (malformed body) -- both reach this same fallback,
      // since neither has a real server-reported message to show instead.
      setBulkError("Bulk approve failed -- try again.");
    } finally {
      setBulkPending(false);
    }
  };

  if (!items && error)
    return (
      <div className="load-error" role="alert">
        <p>{error}</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </div>
    );
  if (!items)
    return (
      <p className="helper-copy" role="status">
        正在載入工作佇列… Loading work queue…
      </p>
    );

  const queueItems = mapDashboardItems(items);
  const eligibleIds = items
    .filter(
      (item) =>
        item.status === "in_review" &&
        item.openBlockingFlagCount === 0 &&
        item.reviewContext != null,
    )
    .map((item) => item.id);

  return (
    <section aria-label="Work queue" aria-busy={loading}>
      {error ? (
        <div className="load-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={reload} disabled={loading}>
            Retry
          </button>
        </div>
      ) : null}
      {stale ? (
        <p role="status">Refreshing work queue… Showing previous results.</p>
      ) : null}
      <p>
        Workspace listings: {data?.totalMatching ?? "unavailable"} matching ·
        Showing page {data?.page ?? page}
      </p>
      {selected.size > 0 ? (
        <div className="bulk-action-bar" role="region" aria-label="批量操作">
          <span>
            {selected.size} 個項目已選取 · {selected.size} selected
          </span>
          <button
            type="button"
            onClick={runBulkApprove}
            disabled={bulkPending || loading || Boolean(error)}
          >
            {bulkPending
              ? "批准中… Approving…"
              : `批准 ${selected.size} 個上架項目`}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={clearSelection}
            disabled={bulkPending || loading}
          >
            清除選取 Clear selection
          </button>
        </div>
      ) : null}
      {bulkError ? (
        <p className="inline-warning" role="alert">
          {bulkError}
        </p>
      ) : null}
      {bulkResult ? (
        <ul className="bulk-result-list" aria-live="polite">
          {bulkResult.results.map((result) =>
            result.ok ? (
              <li key={result.listingId}>✓ {result.listingId}</li>
            ) : (
              <li key={result.listingId}>
                ✗ {result.listingId}: {result.message}
              </li>
            ),
          )}
        </ul>
      ) : null}
      <fieldset
        disabled={loading || bulkPending || Boolean(error)}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        <ListingQueue
          items={queueItems}
          selected={selected}
          eligibleIds={eligibleIds}
          onToggle={toggleSelected}
          onSelectAllEligible={() => selectAllEligible(eligibleIds)}
        />
      </fieldset>
      <nav aria-label="Queue pagination">
        <button
          type="button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={loading || bulkPending || page === 1}
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => setPage((current) => current + 1)}
          disabled={
            loading ||
            bulkPending ||
            !data ||
            page * data.pageSize >= data.totalMatching
          }
        >
          Next
        </button>
      </nav>
    </section>
  );
}
