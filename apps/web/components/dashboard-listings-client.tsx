"use client";

import { useCallback, useId } from "react";
import Link from "next/link";

import type { ListingStatus } from "@wukong/core";

import type { ListingCollectionItem } from "../lib/dashboard-queue-shared";
import { mapDashboardItems } from "../lib/dashboard-queue-shared";
import { useLatestRequest } from "../lib/use-latest-request";
import { SourceReadinessSummary } from "./source-readiness-summary";
import {
  queueGroups,
  type QueueItem,
  type QueueStatus,
} from "./listing-view-models";

export type { ListingCollectionItem } from "../lib/dashboard-queue-shared";
export { mapDashboardItems } from "../lib/dashboard-queue-shared";

/**
 * Workspace-accurate dashboard metrics, derived from the real
 * `countByStatus()` aggregate (not from the 100-row-capped `items` array,
 * which can silently undercount past that window).
 */
export function dashboardMetricsFromCounts(
  counts: Record<ListingStatus, number>,
): { active: number; inReview: number; blocked: number } {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    active: total - counts.published,
    inReview: counts.in_review + counts.reopened,
    blocked: counts.failed + counts.publish_failed,
  };
}

const TEASER_SIZE = 5;
const TEASER_PRIORITY_STATUSES = new Set<QueueStatus>([
  "needs_info",
  "in_review",
]);

function queueGroupOrder(status: QueueStatus): number {
  const index = queueGroups.findIndex((group) => group.status === status);
  return index === -1 ? queueGroups.length : index;
}

/**
 * Picks a small teaser (3-5 items) of the highest-priority queue items for
 * the dashboard. `needs_info`/`in_review` items come first, ordered the
 * same way the full `/queue` view orders its groups (needs_info before
 * in_review); any remaining slots are filled from the rest of the queue,
 * also in `queueGroups` order. The full grouped, selectable queue — and
 * bulk-approve — now live at `/queue`.
 */
export function selectDashboardTeaser(items: QueueItem[]): QueueItem[] {
  const byGroupOrder = (a: QueueItem, b: QueueItem) =>
    queueGroupOrder(a.status) - queueGroupOrder(b.status);
  const priority = items
    .filter((item) => TEASER_PRIORITY_STATUSES.has(item.status))
    .sort(byGroupOrder);
  const rest = items
    .filter((item) => !TEASER_PRIORITY_STATUSES.has(item.status))
    .sort(byGroupOrder);
  return [...priority, ...rest].slice(0, TEASER_SIZE);
}

type ListListingsResponse = {
  items: ListingCollectionItem[];
  counts: Record<ListingStatus, number>;
};

export function DashboardListingsClient() {
  const activeLabelId = useId();
  const inReviewLabelId = useId();
  const blockedLabelId = useId();

  const load = useCallback(async (signal: AbortSignal) => {
    const response = await fetch("/api/listings?page=1&pageSize=5", {
      cache: "no-store",
      signal,
    });
    if (!response.ok)
      throw new Error(`Unable to load listings (${response.status})`);
    return (await response.json()) as ListListingsResponse;
  }, []);
  const { data, error, loading, stale, reload } = useLatestRequest(
    load,
    "Unable to load listings",
  );

  if (!data && error)
    return (
      <div className="load-error" role="alert">
        <p>{error}</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </div>
    );
  if (!data)
    return (
      <p className="helper-copy" role="status">
        正在載入工作佇列… Loading work queue…
      </p>
    );

  const metrics = dashboardMetricsFromCounts(data.counts);
  const teaserItems = selectDashboardTeaser(mapDashboardItems(data.items));

  return (
    <>
      <div className="metric-strip" aria-label="工作台摘要">
        <div role="group" aria-labelledby={activeLabelId}>
          <span className="metric-value">{metrics.active}</span>
          <span className="metric-label" id={activeLabelId}>
            進行中 <small>Active</small>
          </span>
        </div>
        <div role="group" aria-labelledby={inReviewLabelId}>
          <span className="metric-value">{metrics.inReview}</span>
          <span className="metric-label" id={inReviewLabelId}>
            待你審核 <small>Needs review</small>
          </span>
        </div>
        <div role="group" aria-labelledby={blockedLabelId}>
          <span className="metric-value">{metrics.blocked}</span>
          <span className="metric-label" id={blockedLabelId}>
            阻塞上架 <small>Blocked delivery</small>
          </span>
        </div>
      </div>
      <section
        className="queue-group dashboard-queue-teaser"
        aria-busy={loading}
        aria-labelledby="queue-teaser-heading"
      >
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">
              工作佇列 <span>WORK QUEUE</span>
            </p>
            <h2 id="queue-teaser-heading">
              最新五個項目 · Latest five listings
            </h2>
          </div>
          <Link className="text-link" href="/queue">
            查看完整工作佇列 <span>View full queue</span>
          </Link>
        </div>
        <p>
          Bounded view of the latest five workspace listings, ordered within
          this page. Summary metrics cover the full workspace.
        </p>
        {error ? (
          <div role="alert">
            {error}
            <button type="button" onClick={reload}>
              Retry
            </button>
          </div>
        ) : null}
        {stale ? <p role="status">Refreshing latest listings…</p> : null}
        {teaserItems.length > 0 ? (
          <ul className="queue-list">
            {teaserItems.map((item) => (
              <li key={item.id} className="queue-item">
                <div>
                  <Link
                    className="queue-item-title"
                    href={`/listings/${item.id}`}
                  >
                    {item.title}
                  </Link>
                  <p>{item.subtitle}</p>
                  <SourceReadinessSummary
                    readiness={
                      data.items.find((source) => source.id === item.id)
                        ?.sourceReadiness
                    }
                    compact
                  />
                  <time dateTime={item.updatedAt}>{item.updatedAt}</time>
                </div>
                <Link
                  className="secondary-button queue-action"
                  href={`/listings/${item.id}`}
                >
                  {item.nextAction}
                  <span aria-hidden="true"> →</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">
            目前沒有項目 <span>No items</span>
          </p>
        )}
      </section>
    </>
  );
}
