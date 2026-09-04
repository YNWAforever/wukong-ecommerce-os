"use client";

import { useEffect, useState } from "react";

import type { ListingCollectionItem } from "../lib/dashboard-queue-shared";
import { mapDashboardItems } from "../lib/dashboard-queue-shared";
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
  const [items, setItems] = useState<ListingCollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<BulkApproveResponse | null>(
    null,
  );
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState(false);

  const load = () => {
    const controller = new AbortController();
    fetch("/api/listings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Unable to load listings (${response.status})`);
        const body = (await response.json()) as {
          items: ListingCollectionItem[];
        };
        setItems(body.items);
      })
      .catch((loadError: unknown) => {
        if (
          loadError instanceof DOMException &&
          loadError.name === "AbortError"
        )
          return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load listings",
        );
      });
    return controller;
  };

  useEffect(() => {
    const controller = load();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllEligible = (eligibleIds: string[]) => {
    setSelected(new Set(eligibleIds.slice(0, 50)));
  };

  const clearSelection = () => setSelected(new Set());

  const runBulkApprove = async () => {
    setBulkPending(true);
    setBulkResult(null);
    setBulkError(null);
    try {
      const response = await fetch("/api/listings/bulk-approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingIds: [...selected] }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setBulkError(bulkErrorMessage(body));
        return;
      }
      setBulkResult(body as BulkApproveResponse);
      setSelected(new Set());
      load();
    } catch {
      // Covers both a rejected fetch() call (network failure) and a thrown
      // response.json() (malformed body) -- both reach this same fallback,
      // since neither has a real server-reported message to show instead.
      setBulkError("Bulk approve failed -- try again.");
    } finally {
      setBulkPending(false);
    }
  };

  if (error)
    return (
      <p className="inline-warning" role="alert">
        {error}
      </p>
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
      (item) => item.status === "in_review" && item.openBlockingFlagCount === 0,
    )
    .map((item) => item.id);

  return (
    <>
      {selected.size > 0 ? (
        <div className="bulk-action-bar" role="region" aria-label="批量操作">
          <span>
            {selected.size} 個項目已選取 · {selected.size} selected
          </span>
          <button type="button" onClick={runBulkApprove} disabled={bulkPending}>
            {bulkPending
              ? "批准中… Approving…"
              : `批准 ${selected.size} 個上架項目`}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={clearSelection}
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
      <ListingQueue
        items={queueItems}
        selected={selected}
        eligibleIds={eligibleIds}
        onToggle={toggleSelected}
        onSelectAllEligible={() => selectAllEligible(eligibleIds)}
      />
    </>
  );
}
