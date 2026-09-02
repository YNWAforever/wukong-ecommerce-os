import type { NavItem } from "../../components/app-shell-nav";
import type { WorkspaceRole } from "../../lib/session-context";

export const SHELL_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelZh: "總覽", labelEn: "Overview" },
  { href: "/catalog", labelZh: "商品中心", labelEn: "Catalog" },
  { href: "/queue", labelZh: "工作佇列", labelEn: "Work Queue" },
  { href: "/listings/new", labelZh: "建立草稿", labelEn: "New listing" },
  {
    href: "/listings/import",
    labelZh: "SHOPLINE 匯入",
    labelEn: "Bulk import",
  },
  { href: "/batches", labelZh: "批次", labelEn: "Batches" },
  { href: "/jobs", labelZh: "內部作業", labelEn: "Jobs" },
  { href: "/system-map", labelZh: "系統地圖", labelEn: "System map" },
  { href: "/quality", labelZh: "內容品質", labelEn: "Quality" },
];

export const ROLE_LABELS: Record<WorkspaceRole, { zh: string; en: string }> = {
  viewer: { zh: "檢視者", en: "Viewer" },
  operator: { zh: "操作員", en: "Operator" },
  reviewer: { zh: "審閱者", en: "Reviewer" },
  admin: { zh: "管理員", en: "Admin" },
  owner: { zh: "擁有者", en: "Owner" },
};
