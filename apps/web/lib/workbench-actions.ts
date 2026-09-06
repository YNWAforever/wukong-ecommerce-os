import type { WorkbenchItem } from "@wukong/db";

export function workbenchDestination(item: WorkbenchItem): string {
  switch (item.kind) {
    case "listing":
      return `/listings/${encodeURIComponent(item.id)}`;
    case "export":
      return `/jobs?${new URLSearchParams({ kind: "export", attempt: item.id })}`;
    case "website_scan":
      return `/listings/import?${new URLSearchParams({ scan: item.id })}`;
    case "workbook_import":
      return `/catalog?${new URLSearchParams({ filter: "workbook", importId: item.id })}`;
  }
}
