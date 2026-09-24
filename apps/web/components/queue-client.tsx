"use client";
import { useLocale } from "../lib/locale-context";
import { localized, commonCopy, safeUiError } from "../lib/ui-copy";

import { approvalErrorLabel } from "../lib/approval-ui-copy";
import { MAX_BULK_APPROVE_ITEMS } from "../lib/bulk-approve-limit";

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
  const locale = useLocale();
  const c = commonCopy[locale];
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
  // A refused selection, remembered only until there is room again. The cap is
  // correct -- it mirrors what the API accepts -- but refusing in silence left
  // a live-looking checkbox doing nothing at all.
  const [selectionCapped, setSelectionCapped] = useState(false);

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
    if (selection.has(id)) {
      const next = new Map(selection);
      next.delete(id);
      setSelection(next);
      // There is room again, so the warning has nothing left to explain.
      setSelectionCapped(false);
      return;
    }
    const item = items?.find((candidate) => candidate.id === id);
    if (!item?.reviewContext) return;
    if (selection.size >= MAX_BULK_APPROVE_ITEMS) {
      setSelectionCapped(true);
      return;
    }
    const next = new Map(selection);
    next.set(id, { ...item.reviewContext });
    setSelection(next);
  };

  const selectAllEligible = (eligibleIds: string[]) => {
    const next = new Map(selection);
    const itemsById = new Map(items?.map((item) => [item.id, item]));
    let refused = false;
    for (const id of eligibleIds) {
      if (next.has(id)) continue;
      if (next.size >= MAX_BULK_APPROVE_ITEMS) {
        // Stopping here is right; dropping the rest without a word was not.
        refused = true;
        break;
      }
      const context = selection.get(id) ?? itemsById.get(id)?.reviewContext;
      if (context) next.set(id, { ...context });
    }
    setSelection(next);
    setSelectionCapped(refused);
  };

  const clearSelection = () => {
    setSelection(new Map());
    setSelectionCapped(false);
  };

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
        setBulkError(
          response.status === 401 || response.status === 403
            ? String(response.status)
            : bulkErrorMessage(body),
        );
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
      if (approvedIds.size > 0) setSelectionCapped(false);
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
        <p>{safeUiError(error, locale)}</p>
        <button type="button" onClick={reload}>
          {c.retry}
        </button>
      </div>
    );
  if (!items)
    return (
      <p className="helper-copy" role="status">
        {localized(locale, "正在載入工作佇列…", "Loading work queue…")}
      </p>
    );

  const queueItems = mapDashboardItems(items, locale);
  const eligibleIds = items
    .filter(
      (item) =>
        item.status === "in_review" &&
        item.openBlockingFlagCount === 0 &&
        item.reviewContext != null,
    )
    .map((item) => item.id);

  return (
    <section
      aria-label={localized(locale, "工作佇列", "Work queue")}
      aria-busy={loading}
    >
      {error ? (
        <div className="load-error" role="alert">
          <span>{safeUiError(error, locale)}</span>
          <button type="button" onClick={reload} disabled={loading}>
            {c.retry}
          </button>
        </div>
      ) : null}
      {stale ? (
        <p role="status">
          {localized(
            locale,
            "正在更新工作佇列… 顯示上次結果。",
            "Refreshing work queue… Showing previous results.",
          )}
        </p>
      ) : null}
      <p>
        {localized(
          locale,
          `工作區商品：符合 ${data?.totalMatching ?? c.unavailable} 個 · 顯示第 ${data?.page ?? page} 頁`,
          `Workspace listings: ${data?.totalMatching ?? "unavailable"} matching · Showing page ${data?.page ?? page}`,
        )}
      </p>
      {selected.size > 0 ? (
        <div
          className="bulk-action-bar"
          role="region"
          aria-label={localized(locale, "批量操作", "Bulk actions")}
        >
          <span>
            {localized(
              locale,
              `${selected.size} 個項目已選取`,
              `${selected.size} selected`,
            )}
          </span>
          <button
            type="button"
            onClick={runBulkApprove}
            disabled={bulkPending || loading || Boolean(error)}
          >
            {bulkPending
              ? localized(locale, "批准中…", "Approving…")
              : localized(
                  locale,
                  `批准 ${selected.size} 個商品`,
                  `Approve ${selected.size} listings`,
                )}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={clearSelection}
            disabled={bulkPending || loading}
          >
            {c.clearSelection}
          </button>
        </div>
      ) : null}
      {selectionCapped ? (
        <p className="inline-warning" role="alert">
          {localized(
            locale,
            `一次最多可選取 ${MAX_BULK_APPROVE_ITEMS} 個項目。請先批准已選取的項目，再選取其餘項目。`,
            `You can select at most ${MAX_BULK_APPROVE_ITEMS} listings at a time. Approve the ones you have selected, then select the rest.`,
          )}
        </p>
      ) : null}
      {bulkError ? (
        <p className="inline-warning" role="alert">
          {safeUiError(bulkError, locale, "action")}
        </p>
      ) : null}
      {bulkResult ? (
        <ul className="bulk-result-list" aria-live="polite">
          {bulkResult.results.map((result) =>
            result.ok ? (
              <li key={result.listingId}>✓ {result.listingId}</li>
            ) : (
              <li key={result.listingId}>
                ✗ {result.listingId}: {approvalErrorLabel(result.code, locale)}
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
      <nav aria-label={localized(locale, "佇列分頁", "Queue pagination")}>
        <button
          type="button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={loading || bulkPending || page === 1}
        >
          {c.previous}
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
          {c.next}
        </button>
      </nav>
    </section>
  );
}
