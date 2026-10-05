export const CATALOG_QUERY_FILTERS = [
  "all",
  "website",
  "workbook",
  "drafts",
  "bound",
  "attention",
  "review",
  "unlinked",
  "published",
] as const;
export const JOB_QUERY_KINDS = [
  "all",
  "batch",
  "publish_job",
  "pipeline_run",
  "export",
  "import_result",
] as const;
export type CatalogQuery = {
  q: string;
  work: "all" | "mine" | "unassigned" | "review";
  filter: (typeof CATALOG_QUERY_FILTERS)[number];
  page: number;
  importId: string | null;
  invalidImport: boolean;
  cursor?: string;
};
export type JobsQuery = {
  kind: (typeof JOB_QUERY_KINDS)[number];
  page: number;
  cursor?: string;
};
function page(value: string | null): number {
  return value && /^[1-9][0-9]*$/.test(value) && Number(value) <= 21474836
    ? Number(value)
    : 1;
}
export function parseCatalogQuery(
  input: string | URLSearchParams,
): CatalogQuery {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const rawImport = params.get("importId");
  const importId =
    rawImport &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      rawImport,
    )
      ? rawImport
      : null;
  const filter = params.get("filter");
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    work:
      (["all", "mine", "unassigned", "review"] as const).find(
        (value) => value === params.get("work"),
      ) ?? "all",
    page: page(params.get("page")),
    filter: CATALOG_QUERY_FILTERS.find((value) => value === filter) ?? "all",
    importId,
    invalidImport: params.has("importId") && !importId,
    ...(params.has("cursor")
      ? { cursor: boundedCursor(params.get("cursor")) }
      : {}),
  };
}
export function catalogQuery(input: CatalogQuery): string {
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q.slice(0, 200));
  if (input.filter !== "all") params.set("filter", input.filter);
  if (input.work !== "all") params.set("work", input.work);
  if (input.page > 1) params.set("page", String(input.page));
  if (input.importId) params.set("importId", input.importId);
  if (input.cursor) params.set("cursor", input.cursor);
  return params.toString();
}
export function catalogContextKey(input: string | URLSearchParams): string {
  const query = catalogQuery(parseCatalogQuery(input));
  return "/catalog" + (query ? "?" + query : "");
}
export function parseJobsQuery(input: string | URLSearchParams): JobsQuery {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  return {
    kind:
      JOB_QUERY_KINDS.find((value) => value === params.get("kind")) ?? "all",
    page: page(params.get("page")),
    ...(params.has("cursor")
      ? { cursor: boundedCursor(params.get("cursor")) }
      : {}),
  };
}
export function jobsQuery(input: JobsQuery): string {
  const params = new URLSearchParams();
  if (input.kind !== "all") params.set("kind", input.kind);
  if (input.page > 1) params.set("page", String(input.page));
  if (input.cursor) params.set("cursor", input.cursor);
  return params.toString();
}
function boundedCursor(value: string | null) {
  // Retain an invalid sentinel so a malformed scoped link fails on the server,
  // instead of silently fetching a different page.
  return value && value.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : "invalid";
}
