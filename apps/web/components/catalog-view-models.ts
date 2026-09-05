import type { ListingStatus } from "@wukong/core";

export type CatalogFilter =
  "all" | "attention" | "review" | "unlinked" | "published";

export const CATALOG_FILTERS: ReadonlyArray<{
  value: CatalogFilter;
  labelZh: string;
  labelEn: string;
}> = [
  { value: "all", labelZh: "全部", labelEn: "All" },
  { value: "attention", labelZh: "需處理", labelEn: "Attention" },
  { value: "review", labelZh: "待審核", labelEn: "Review" },
  { value: "unlinked", labelZh: "未建立草稿", labelEn: "Unlinked" },
  { value: "published", labelZh: "已發佈", labelEn: "Published" },
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
