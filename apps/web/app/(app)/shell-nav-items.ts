import type { NavItem } from "../../components/app-shell-nav";
import type { WorkspaceRole } from "../../lib/session-context";

export const SHELL_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelZh: "工作台", labelEn: "Workbench" },
  { href: "/catalog", labelZh: "商品中心", labelEn: "Catalog" },
  { href: "/listings/import", labelZh: "匯入", labelEn: "Imports" },
  {
    href: "/jobs?kind=export",
    labelZh: "匯出與結果",
    labelEn: "Exports & results",
  },
  {
    href: "/queue",
    labelZh: "工作佇列",
    labelEn: "Work Queue",
    group: "tools",
  },
  { href: "/batches", labelZh: "批次", labelEn: "Batches", group: "tools" },
  {
    href: "/listings/new",
    labelZh: "建立草稿",
    labelEn: "New listing",
    group: "tools",
  },
  { href: "/jobs", labelZh: "所有作業", labelEn: "All Jobs", group: "tools" },
  { href: "/quality", labelZh: "內容品質", labelEn: "Quality", group: "tools" },
  {
    href: "/system-map",
    labelZh: "系統地圖",
    labelEn: "System map",
    group: "tools",
  },
];

export const ROLE_LABELS: Record<WorkspaceRole, { zh: string; en: string }> = {
  viewer: { zh: "檢視者", en: "Viewer" },
  operator: { zh: "操作員", en: "Operator" },
  reviewer: { zh: "審核員", en: "Reviewer" },
  admin: { zh: "管理員", en: "Admin" },
  owner: { zh: "擁有者", en: "Owner" },
};
