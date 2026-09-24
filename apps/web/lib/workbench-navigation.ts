/** Only bounded dashboard filters may survive a contextual return. */
export function normalizeWorkbenchReturn(input: string | null): string {
  if (
    !input ||
    input.length > 1024 ||
    !input.startsWith("/dashboard") ||
    /[\\\x00-\x20]/.test(input)
  )
    return "/dashboard";
  try {
    const url = new URL(input, "http://workbench.invalid");
    if (
      url.origin !== "http://workbench.invalid" ||
      url.pathname !== "/dashboard"
    )
      return "/dashboard";
    const out = new URLSearchParams();
    const state = url.searchParams.get("state"),
      kind = url.searchParams.get("kind"),
      page = url.searchParams.get("page");
    if (
      state &&
      ["attention", "progress", "completed", "unclassified"].includes(state)
    )
      out.set("state", state);
    if (
      kind &&
      ["listing", "export", "website_scan", "workbook_import"].includes(kind)
    )
      out.set("kind", kind);
    if (page && /^[1-9][0-9]*$/.test(page) && Number(page) <= 21474836)
      out.set("page", page);
    return out.size ? `/dashboard?${out}` : "/dashboard";
  } catch {
    return "/dashboard";
  }
}
export function exactQueryId(input: string | null): string | null {
  return input &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input,
    )
    ? input
    : null;
}
export function withWorkbenchReturn(
  destination: string,
  returnTo?: string | null,
): string {
  if (!returnTo) return destination;
  const [path, query] = destination.split("?");
  const params = new URLSearchParams(query);
  params.set("returnTo", normalizeWorkbenchReturn(returnTo));
  return `${path}?${params}`;
}
export function initialDestinationSearch(input?: string): URLSearchParams {
  return new URLSearchParams(
    input ?? (typeof window === "undefined" ? "" : window.location.search),
  );
}
export function serializeDestinationQuery(
  query: Record<string, string | string[] | undefined>,
): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (typeof value === "string") out.set(key, value);
  return out.toString();
}
