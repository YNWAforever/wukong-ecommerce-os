// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { ListingStatus } from "@wukong/core";

import {
  DashboardListingsClient,
  dashboardMetricsFromCounts,
  mapDashboardItems,
  selectDashboardTeaser,
} from "./dashboard-listings-client";
import type { QueueItem } from "./listing-view-models";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(DashboardListingsClient));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
}

const zeroCounts: Record<ListingStatus, number> = {
  received: 0,
  processing: 0,
  needs_info: 0,
  in_review: 0,
  approved: 0,
  reopened: 0,
  publishing: 0,
  published: 0,
  publish_failed: 0,
  failed: 0,
};

const baseItem = {
  id: "listing_1",
  status: "in_review" as const,
  target: "shopline" as const,
  title: "Demo Wine",
  sku: "OPAK-001",
  updatedAt: "2026-08-16T00:00:00.000Z",
  openBlockingFlagCount: 0,
  reviewContext: null,
};

describe("mapDashboardItems", () => {
  it("carries openBlockingFlagCount through to the queue item", () => {
    const [item] = mapDashboardItems([
      { ...baseItem, openBlockingFlagCount: 2 },
    ]);
    expect(item?.openBlockingFlagCount).toBe(2);
  });

  it("carries a zero count through unchanged", () => {
    const [item] = mapDashboardItems([baseItem]);
    expect(item?.openBlockingFlagCount).toBe(0);
  });
});

describe("dashboardMetricsFromCounts", () => {
  it("computes active as the total minus published", () => {
    const counts = { ...zeroCounts, received: 3, published: 10 };
    expect(dashboardMetricsFromCounts(counts).active).toBe(3);
  });

  it("computes inReview as in_review plus reopened", () => {
    const counts = { ...zeroCounts, in_review: 4, reopened: 2 };
    expect(dashboardMetricsFromCounts(counts).inReview).toBe(6);
  });

  it("computes blocked as failed plus publish_failed", () => {
    const counts = { ...zeroCounts, failed: 1, publish_failed: 3 };
    expect(dashboardMetricsFromCounts(counts).blocked).toBe(4);
  });

  it("is unaffected by counts exceeding a 100-row window", () => {
    // This is the whole point of sourcing metrics from countByStatus:
    // a workspace with far more than 100 listings must still report an
    // accurate active count.
    const counts = { ...zeroCounts, received: 250, published: 40 };
    expect(dashboardMetricsFromCounts(counts).active).toBe(250);
  });
});

function queueItem(overrides: Partial<QueueItem>): QueueItem {
  return {
    id: "listing_1",
    title: "Demo Wine",
    subtitle: "OPAK-001 · SHOPLINE",
    status: "in_review",
    updatedAt: "剛剛更新",
    nextAction: "繼續審核",
    openBlockingFlagCount: 0,
    ...overrides,
  };
}

describe("selectDashboardTeaser", () => {
  it("prioritizes needs_info and in_review items over other statuses", () => {
    const items = [
      queueItem({ id: "published_1", status: "published" }),
      queueItem({ id: "review_1", status: "in_review" }),
      queueItem({ id: "needs_info_1", status: "needs_info" }),
    ];

    const teaser = selectDashboardTeaser(items);

    expect(teaser.map((item) => item.id)).toEqual([
      "needs_info_1",
      "review_1",
      "published_1",
    ]);
  });

  it("caps the teaser at 5 items even when more are eligible", () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      queueItem({ id: `review_${index}`, status: "in_review" }),
    );

    expect(selectDashboardTeaser(items)).toHaveLength(5);
  });

  it("fills remaining slots from other statuses once priority items run out", () => {
    const items = [
      queueItem({ id: "review_1", status: "in_review" }),
      queueItem({ id: "approved_1", status: "approved" }),
      queueItem({ id: "published_1", status: "published" }),
    ];

    const teaser = selectDashboardTeaser(items);

    expect(teaser.map((item) => item.id)).toEqual([
      "review_1",
      "approved_1",
      "published_1",
    ]);
  });
});

describe("DashboardListingsClient", () => {
  it("computes the metric strip from response.counts, not from the items array", async () => {
    // Only one item is returned (as if capped/paginated), but counts
    // reports the workspace-wide totals — the metric strip must reflect
    // counts, never `items.length`-style derivation.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [baseItem],
        counts: {
          ...zeroCounts,
          received: 40,
          in_review: 5,
          reopened: 1,
          failed: 2,
          publish_failed: 1,
          published: 100,
        },
      }),
    );

    const { container, root } = await mount(fetcher);

    const values = Array.from(container.querySelectorAll(".metric-value")).map(
      (node) => node.textContent,
    );
    // active = total(149) - published(100) = 49
    // inReview = in_review(5) + reopened(1) = 6
    // blocked = failed(2) + publish_failed(1) = 3
    expect(values).toEqual(["49", "6", "3"]);

    await unmount(root);
  });

  it('exposes each metric tile as a role="group" tied to its visible label', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [baseItem],
        counts: {
          ...zeroCounts,
          received: 40,
          in_review: 5,
          reopened: 1,
          failed: 2,
          publish_failed: 1,
          published: 100,
        },
      }),
    );

    const { container, root } = await mount(fetcher);

    const tiles = container.querySelectorAll('[role="group"]');
    expect(tiles.length).toBe(3);

    const expectedSubstrings = ["進行中", "待你審核", "阻塞上架"];

    tiles.forEach((tile, index) => {
      const labelledBy = tile.getAttribute("aria-labelledby");
      expect(labelledBy).not.toBeNull();
      const labelElement = document.getElementById(labelledBy!);
      expect(labelElement?.textContent).toContain(expectedSubstrings[index]);
    });

    await unmount(root);
  });

  it("renders only a small teaser, not the full grouped queue", async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      ...baseItem,
      id: `listing_${index}`,
      title: `Wine ${index}`,
      status: "in_review" as const,
    }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items,
        counts: { ...zeroCounts, in_review: 8 },
      }),
    );

    const { container, root } = await mount(fetcher);

    // The full queue lives at /queue now; the dashboard's grouped,
    // multi-lane view (queue-groups) must not appear here.
    expect(container.querySelector(".queue-groups")).toBeNull();
    expect(container.querySelectorAll(".queue-item").length).toBe(5);

    await unmount(root);
  });

  it("links to /queue for the full work queue", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [baseItem],
        counts: { ...zeroCounts, in_review: 1 },
      }),
    );

    const { container, root } = await mount(fetcher);

    const link = container.querySelector('a[href="/queue"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("查看完整工作佇列");

    await unmount(root);
  });

  it("no longer renders bulk-approve controls", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [{ ...baseItem, status: "in_review" }],
        counts: { ...zeroCounts, in_review: 1 },
      }),
    );

    const { container, root } = await mount(fetcher);

    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.querySelector(".bulk-action-bar")).toBeNull();

    await unmount(root);
  });

  it("shows a loading state before the fetch resolves", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValue(new Promise(() => {}));

    const { container, root } = await mount(fetcher);

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("正在載入");

    await unmount(root);
  });

  it("shows an error state instead of crashing when the fetch fails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const { container, root } = await mount(fetcher);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();

    await unmount(root);
  });
});
