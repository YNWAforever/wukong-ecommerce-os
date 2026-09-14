import type { NavItem } from "../../components/app-shell-nav";
import {
  requireWorkspaceRole,
  type WorkspaceRole,
} from "../../lib/session-context";

export const SHELL_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelZh: "工作台", labelEn: "Workbench" },
  { href: "/catalog", labelZh: "商品中心", labelEn: "Catalog" },
  {
    href: "/listings/import",
    labelZh: "匯入",
    labelEn: "Imports",
    role: "operator",
  },
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
  {
    href: "/batches",
    labelZh: "批次",
    labelEn: "Batches",
    group: "tools",
    role: "operator",
  },
  {
    href: "/listings/new",
    labelZh: "建立草稿",
    labelEn: "New listing",
    group: "tools",
    role: "operator",
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

/**
 * The destinations a reader at this role can actually use.
 *
 * The shell offered every member every destination, so a viewer saw Imports,
 * New listing and Batches -- all three refused by their own APIs, and Batches
 * refused on the GET as well, so the page rendered nothing but a permission
 * error.
 *
 * This is not a security boundary and must not be read as one: every route and
 * API enforces its own role server-side, and hiding a link protects nobody. It
 * reuses `requireWorkspaceRole` rather than comparing roles itself, so the nav
 * and the server cannot disagree about what "operator" ranks above.
 */
export function visibleNavItems(role: WorkspaceRole | null): NavItem[] {
  return SHELL_NAV_ITEMS.filter(
    (item) =>
      !item.role || (role !== null && requireWorkspaceRole(item.role, role)),
  );
}
