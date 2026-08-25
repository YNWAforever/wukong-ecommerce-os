import type { ListingStatus } from "@wukong/core";

export type CatalogOrigin = "import" | "created";

export type CatalogItem = {
  id: string;
  remoteProductId: string;
  origin: CatalogOrigin;
  sku: string | null;
  listingId: string | null;
  specVersion: string | null;
  title: string;
  listingStatus: ListingStatus | null;
  openBlockingFlagCount: number | null;
  needsReview: boolean;
  needsAttention: boolean;
};

export type CatalogSummary = {
  total: number;
  linked: number;
  unlinked: number;
  needsReview: number;
  needsAttention: number;
  published: number;
};

export type CatalogResponse = {
  items: CatalogItem[];
  summary: CatalogSummary;
};

export function summarizeCatalog(
  items: readonly CatalogItem[],
): CatalogSummary {
  return {
    total: items.length,
    linked: items.filter((item) => item.listingId !== null).length,
    unlinked: items.filter((item) => item.listingId === null).length,
    needsReview: items.filter((item) => item.needsReview).length,
    needsAttention: items.filter((item) => item.needsAttention).length,
    published: items.filter((item) => item.listingStatus === "published").length,
  };
}
