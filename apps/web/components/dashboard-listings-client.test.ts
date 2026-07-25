import { describe, expect, it } from "vitest";

import {
  dashboardMetrics,
  mapDashboardItems,
  type ListingCollectionItem,
} from "./dashboard-listings-client.js";

const items: ListingCollectionItem[] = [
  {
    id: "listing-1",
    status: "processing",
    target: "shopline",
    title: "Processing wine",
    sku: null,
    updatedAt: "2026-07-18T05:00:00.000Z",
  },
  {
    id: "listing-2",
    status: "reopened",
    target: "shopline",
    title: "Opak Riesling",
    sku: "OPAK-001",
    updatedAt: "2026-07-18T04:00:00.000Z",
  },
  {
    id: "listing-3",
    status: "publish_failed",
    target: "shopline",
    title: "Failed wine",
    sku: "OPAK-002",
    updatedAt: "2026-07-18T03:00:00.000Z",
  },
  {
    id: "listing-4",
    status: "published",
    target: "shopline",
    title: "Published wine",
    sku: "OPAK-003",
    updatedAt: "2026-07-18T02:00:00.000Z",
  },
];

describe("dashboard listing mapping", () => {
  it("maps every workflow state into a visible work queue group", () => {
    const mapped = mapDashboardItems(items);

    expect(mapped).toEqual([
      expect.objectContaining({
        id: "listing-1",
        status: "processing",
        nextAction: "查看處理狀態",
      }),
      expect.objectContaining({
        id: "listing-2",
        status: "in_review",
        subtitle: expect.stringContaining("OPAK-001"),
      }),
      expect.objectContaining({
        id: "listing-3",
        status: "failed",
        nextAction: "查看錯誤",
      }),
      expect.objectContaining({
        id: "listing-4",
        status: "published",
        nextAction: "查看商品",
      }),
    ]);
  });

  it("derives dashboard metrics from real listing states", () => {
    expect(dashboardMetrics(items)).toEqual({
      active: 3,
      inReview: 1,
      blocked: 1,
    });
  });
});
