import type { ListingStatus } from "@wukong/core";

export type CatalogFilter =
  | "workbook"
  | "website"
  | "all"
  | "attention"
  | "review"
  | "unlinked"
  | "published";

export const CATALOG_FILTERS: ReadonlyArray<{
  value: CatalogFilter;
  labelZh: string;
  labelEn: string;
}> = [
  { value: "website", labelZh: "網站", labelEn: "Website" },
  { value: "workbook", labelZh: "試算表", labelEn: "Workbook" },
  { value: "all", labelZh: "全部", labelEn: "All" },
  { value: "attention", labelZh: "需處理", labelEn: "Attention" },
  { value: "review", labelZh: "待審核", labelEn: "Review" },
  {
    value: "unlinked",
    labelZh: "平台未建立草稿",
    labelEn: "Unlinked platform",
  },
  { value: "published", labelZh: "已發佈", labelEn: "Published" },
];

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
