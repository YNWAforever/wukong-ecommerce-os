import { describe, expect, it } from "vitest";

import type { CatalogItem } from "../lib/catalog-contract";
import {
  catalogStatusLabel,
  filterCatalogItems,
} from "./catalog-view-models.js";

const items: CatalogItem[] = [
  {
    id: "product-1",
    remoteProductId: "remote-1",
    origin: "import",
    sku: "OPAK-RIESLING",
    listingId: "listing-1",
    specVersion: "v1",
    title: "Opak 雷司令",
    listingStatus: "in_review",
    openBlockingFlagCount: 0,
    needsReview: true,
    needsAttention: false,
  },
  {
    id: "product-2",
    remoteProductId: "remote-2",
    origin: "import",
    sku: "OPAK-UNLINKED",
    listingId: null,
    specVersion: "v1",
    title: "Unlinked bottle",
    listingStatus: null,
    openBlockingFlagCount: null,
    needsReview: false,
    needsAttention: true,
  },
  {
    id: "product-3",
    remoteProductId: "remote-3",
    origin: "created",
    sku: "OPAK-LIVE",
    listingId: "listing-3",
    specVersion: null,
    title: "Published bottle",
    listingStatus: "published",
    openBlockingFlagCount: 0,
    needsReview: false,
    needsAttention: false,
  },
];

describe("catalog view models", () => {
  it("filters by workflow cohort", () => {
    expect(filterCatalogItems(items, "", "review").map((item) => item.id)).toEqual([
      "product-1",
    ]);
    expect(
      filterCatalogItems(items, "", "unlinked").map((item) => item.id),
    ).toEqual(["product-2"]);
    expect(
      filterCatalogItems(items, "", "published").map((item) => item.id),
    ).toEqual(["product-3"]);
  });

  it("searches title, SKU, remote product ID, and spec version", () => {
    expect(
      filterCatalogItems(items, "riesling", "all").map((item) => item.id),
    ).toEqual(["product-1"]);
    expect(
      filterCatalogItems(items, "remote-2", "all").map((item) => item.id),
    ).toEqual(["product-2"]);
  });

  it("labels products without a Wukong draft explicitly", () => {
    expect(catalogStatusLabel(null)).toBe("未建立草稿 No draft");
  });
});
