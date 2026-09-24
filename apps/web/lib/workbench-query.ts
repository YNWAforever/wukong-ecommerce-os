import type { WorkbenchKind, WorkbenchQuery, WorkbenchState } from "@wukong/db";
export const workbenchStates: WorkbenchState[] = [
  "attention",
  "progress",
  "completed",
  "unclassified",
];
export const workbenchKinds: WorkbenchKind[] = [
  "listing",
  "export",
  "website_scan",
  "workbook_import",
];
export function parseWorkbenchQuery(value: string): WorkbenchQuery {
  const params = new URLSearchParams(value);
  const state = params.get("state") as WorkbenchState;
  const kind = params.get("kind") as WorkbenchKind;
  const raw = params.get("page") ?? "1";
  return {
    state: workbenchStates.includes(state) ? state : "attention",
    ...(workbenchKinds.includes(kind) ? { kind } : {}),
    page:
      /^[1-9][0-9]*$/.test(raw) && Number(raw) <= 21474836 ? Number(raw) : 1,
    pageSize: 25,
  };
}
export function workbenchQueryKey(query: WorkbenchQuery): string {
  const params = new URLSearchParams({ state: query.state });
  if (query.kind) params.set("kind", query.kind);
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));
  return params.toString();
}
export function workbenchUrl(query: WorkbenchQuery): string {
  const params = new URLSearchParams(workbenchQueryKey(query));
  params.delete("pageSize");
  return `/dashboard?${params}`;
}
export function changeWorkbenchQuery(
  query: WorkbenchQuery,
  change: Partial<Pick<WorkbenchQuery, "kind" | "state" | "page">>,
): WorkbenchQuery {
  return {
    ...query,
    ...change,
    ...("kind" in change || "state" in change ? { page: 1 } : {}),
  };
}
