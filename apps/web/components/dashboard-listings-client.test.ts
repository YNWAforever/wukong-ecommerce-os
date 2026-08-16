import { describe, expect, it } from "vitest";

import { mapDashboardItems } from "./dashboard-listings-client";

const baseItem = {
  id: "listing_1",
  status: "in_review" as const,
  target: "shopline" as const,
  title: "Demo Wine",
  sku: "OPAK-001",
  updatedAt: "2026-08-16T00:00:00.000Z",
  openBlockingFlagCount: 0,
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
