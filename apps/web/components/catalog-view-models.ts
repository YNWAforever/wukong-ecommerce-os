export type CatalogFilter =
  | "workbook"
  | "website"
  | "all"
  | "drafts"
  | "bound"
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
  { value: "bound", labelZh: "已綁定 SHOPLINE", labelEn: "Bound SHOPLINE" },
  { value: "all", labelZh: "全部", labelEn: "All" },
  { value: "drafts", labelZh: "商品草稿流程", labelEn: "Listing workflows" },
  { value: "attention", labelZh: "需處理", labelEn: "Attention" },
  { value: "review", labelZh: "待審核", labelEn: "Review" },
  {
    value: "unlinked",
    labelZh: "平台未建立草稿",
    labelEn: "Unlinked platform",
  },
  { value: "published", labelZh: "已發佈", labelEn: "Published" },
];
