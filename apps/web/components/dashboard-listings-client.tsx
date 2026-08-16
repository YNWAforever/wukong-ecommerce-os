"use client";

import type { ListingStatus } from "@wukong/core";
import { useEffect, useState } from "react";

import { ListingQueue } from "./listing-queue";
import type { QueueItem, QueueStatus } from "./listing-view-models";

export type ListingCollectionItem = {
  id: string;
  status: ListingStatus;
  target: "shopline";
  title: string;
  sku: string | null;
  updatedAt: string;
  openBlockingFlagCount: number;
};

function queueStatus(status: ListingStatus): QueueStatus {
  if (status === "reopened") return "in_review";
  if (status === "publish_failed") return "failed";
  return status;
}

const nextActions: Record<QueueStatus, string> = {
  received: "查看草稿",
  processing: "查看處理狀態",
  needs_info: "補充資料",
  in_review: "繼續審核",
  approved: "準備上架",
  publishing: "查看發布狀態",
  published: "查看商品",
  failed: "查看錯誤",
};

export function mapDashboardItems(items: ListingCollectionItem[]): QueueItem[] {
  return items.map((item) => {
    const status = queueStatus(item.status);
    return {
      id: item.id,
      title: item.title,
      subtitle: `${item.sku ?? "未有 SKU"} · SHOPLINE`,
      status,
      updatedAt: new Intl.DateTimeFormat("zh-HK", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(item.updatedAt)),
      nextAction: nextActions[status],
      openBlockingFlagCount: item.openBlockingFlagCount,
    };
  });
}

export function dashboardMetrics(items: ListingCollectionItem[]) {
  return {
    active: items.filter((item) => item.status !== "published").length,
    inReview: items.filter(
      (item) => item.status === "in_review" || item.status === "reopened",
    ).length,
    blocked: items.filter(
      (item) => item.status === "failed" || item.status === "publish_failed",
    ).length,
  };
}

type BulkApproveResultItem =
  | { listingId: string; ok: true; versionId: string }
  | { listingId: string; ok: false; code: string; message: string };

type BulkApproveResponse = {
  results: BulkApproveResultItem[];
  approved: number;
  failed: number;
};

export function DashboardListingsClient() {
  const [items, setItems] = useState<ListingCollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<BulkApproveResponse | null>(
    null,
  );
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
    try {
      const response = await fetch("/api/listings/bulk-approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingIds: [...selected] }),
      });
      const body = (await response.json()) as BulkApproveResponse;
      setBulkResult(body);
      setSelected(new Set());
      load();
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

  const metrics = dashboardMetrics(items);
  const queueItems = mapDashboardItems(items);
  const eligibleIds = items
    .filter(
      (item) => item.status === "in_review" && item.openBlockingFlagCount === 0,
    )
    .map((item) => item.id);

  return (
    <>
      <div className="metric-strip" aria-label="工作台摘要">
        <div>
          <span className="metric-value">{metrics.active}</span>
          <span className="metric-label">
            進行中 <small>Active</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{metrics.inReview}</span>
          <span className="metric-label">
            待你審核 <small>Needs review</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{metrics.blocked}</span>
          <span className="metric-label">
            阻塞上架 <small>Blocked delivery</small>
          </span>
        </div>
      </div>
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
