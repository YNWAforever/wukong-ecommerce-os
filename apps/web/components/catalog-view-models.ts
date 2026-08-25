import type { ListingStatus } from "@wukong/core";

import type { CatalogItem } from "../lib/catalog-contract";

export type CatalogFilter =
  | "all"
  | "attention"
  | "review"
  | "unlinked"
  | "published";

export const CATALOG_FILTERS: ReadonlyArray<{
  value: CatalogFilter;
  label: string;
}> = [
  { value: "all", label: "全部 All" },
  { value: "attention", label: "需處理 Attention" },
  { value: "review", label: "待審核 Review" },
  { value: "unlinked", label: "未建立草稿 Unlinked" },
  { value: "published", label: "已發佈 Published" },
];

const STATUS_LABELS: Record<ListingStatus, string> = {
  received: "已收到 Received",
  processing: "處理中 Processing",
  needs_info: "待補資料 Needs info",
  in_review: "待審核 In review",
  approved: "已批准 Approved",
  reopened: "已重開 Reopened",
  publishing: "發佈中 Publishing",
  published: "已發佈 Published",
  publish_failed: "發佈失敗 Publish failed",
  failed: "失敗 Failed",
};

export function catalogStatusLabel(status: ListingStatus | null): string {
  return status === null ? "未建立草稿 No draft" : STATUS_LABELS[status];
}

export function catalogStatusTone(
  status: ListingStatus | null,
): "neutral" | "warning" | "success" | "danger" {
  if (status === "published") return "success";
  if (status === "failed" || status === "publish_failed") return "danger";
  if (
    status === "needs_info" ||
    status === "in_review" ||
    status === "reopened"
  ) {
    return "warning";
  }
  return "neutral";
}

export function filterCatalogItems(
  items: readonly CatalogItem[],
  query: string,
  filter: CatalogFilter,
): CatalogItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return items.filter((item) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "attention" && item.needsAttention) ||
      (filter === "review" && item.needsReview) ||
      (filter === "unlinked" && item.listingId === null) ||
      (filter === "published" && item.listingStatus === "published");
    if (!matchesFilter) return false;
    if (!normalizedQuery) return true;

    return [item.title, item.sku, item.remoteProductId, item.specVersion]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}
