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

export function DashboardListingsClient() {
  const [items, setItems] = useState<ListingCollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
    return () => controller.abort();
  }, []);

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
      <ListingQueue items={mapDashboardItems(items)} />
    </>
  );
}
