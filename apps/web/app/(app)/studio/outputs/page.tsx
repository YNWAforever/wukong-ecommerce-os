import Link from "next/link";
import { cookies } from "next/headers";

import { StudioOutputCard } from "../../../../components/studio-output-card";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import {
  STUDIO_OUTPUT_KINDS,
  STUDIO_OUTPUT_STATUSES,
  STUDIO_PAGE_SIZE,
  studioOutputListQuerySchema,
  type StudioOutputListQuery,
} from "../../../../lib/studio/contracts";
import { toOutputStatus } from "../../../../lib/studio/output-status";
import { renderStudioLine } from "../../../../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../../../../lib/studio-copy";
import styles from "../../../../components/studio.module.css";
import { studioService } from "../studio-service";

const OUTPUT_STATUS_COPY: Record<
  (typeof STUDIO_OUTPUT_STATUSES)[number],
  StudioCopyKey
> = {
  draft: "studio.signoff.draft",
  saved: "studio.signoff.saved",
  signed_off: "studio.signoff.signedOff",
  discarded: "studio.signoff.discarded",
};

/**
 * `/studio/outputs` ??saved artifacts (plan Task 9, design spec 禮2.1; B5.1).
 *
 * The list is server-filtered through the same service as the API:
 * `?q=` searches titles, `?kind=`/`?status=` are exact filters. Filtering
 * happens before the page limit, so a match beyond the first page is still
 * found; the form is a plain GET form and works without client JavaScript.
 *
 * The collapsed row shows only the fields the list read returned (kind, title,
 * status) and loads the version content when opened, so a page of artifacts
 * does not fetch every payload up front. Sign-off is gated by the role resolved
 * server-side; the artifact's own status decides whether the button is
 * meaningful. A failed read shows an honest failure line rather than an empty
 * list that would imply "no artifacts exist".
 */
function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export default async function StudioOutputsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    q?: string | string[];
    kind?: string | string[];
    status?: string | string[];
    offset?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const candidate: Record<string, string> = {};
  for (const key of ["q", "kind", "status", "offset"] as const) {
    const value = firstParam(params[key]);
    if (value !== null && value.length > 0) candidate[key] = value;
  }
  const parsed = studioOutputListQuerySchema.safeParse(candidate);
  const filters: StudioOutputListQuery = parsed.success ? parsed.data : {};
  const search = filters.q?.trim() ?? "";
  const offset = filters.offset ?? 0;
  const filtered =
    !parsed.success ||
    search.length > 0 ||
    filters.kind !== undefined ||
    filters.status !== undefined;

  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  const session = await authSessionContext.resolve();
  const canSignOff = session
    ? requireWorkspaceRole("reviewer", session.role)
    : false;

  let listed;
  try {
    listed = await studioService().listOutputs(filters);
  } catch (error) {
    console.info(
      JSON.stringify({
        event: "studio_outputs_read_failed",
        outcome: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return (
      <div className={styles["studio-section"]}>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.outputs.title")}
        </h1>
        <p className={styles["studio-notice"]} role="alert">
          {studioCopy(locale, "studio.outputs.listError")}
        </p>
      </div>
    );
  }

  const items = listed.items;
  const page = Math.floor(offset / STUDIO_PAGE_SIZE) + 1;

  const pageHref = (nextOffset: number): string => {
    const query = new URLSearchParams();
    if (search.length > 0) query.set("q", search);
    if (filters.kind !== undefined) query.set("kind", filters.kind);
    if (filters.status !== undefined) query.set("status", filters.status);
    if (nextOffset > 0) query.set("offset", String(nextOffset));
    const serialized = query.toString();
    return serialized.length > 0
      ? `/studio/outputs?${serialized}`
      : "/studio/outputs";
  };
  const newerHref =
    offset > 0 ? pageHref(Math.max(0, offset - STUDIO_PAGE_SIZE)) : null;
  const earlierHref = listed.truncated
    ? pageHref(offset + STUDIO_PAGE_SIZE)
    : null;

  return (
    <div className={styles["studio-section"]}>
      <header className={styles["studio-home-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {studioCopy(locale, "studio.rail.outputs")}
        </p>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.outputs.title")}
        </h1>
        <p className={styles["studio-home-lede"]}>
          {studioCopy(locale, "studio.outputs.intro")}
        </p>
      </header>

      <form
        className={styles["studio-output-filters"]}
        action="/studio/outputs"
        method="get"
        role="search"
        aria-label={studioCopy(locale, "studio.outputs.filtersTitle")}
      >
        <div className={styles["studio-output-filter-field"]}>
          <label htmlFor="studio-outputs-search">
            {studioCopy(locale, "studio.outputs.searchLabel")}
          </label>
          <input
            id="studio-outputs-search"
            className={styles["studio-thread-search-input"]}
            type="search"
            name="q"
            maxLength={120}
            defaultValue={search}
            placeholder={studioCopy(locale, "studio.outputs.searchPlaceholder")}
          />
        </div>
        <div className={styles["studio-output-filter-field"]}>
          <label htmlFor="studio-outputs-kind">
            {studioCopy(locale, "studio.outputs.filterKind")}
          </label>
          <select
            id="studio-outputs-kind"
            name="kind"
            className={styles["studio-output-filter-select"]}
            defaultValue={filters.kind ?? ""}
          >
            <option value="">
              {studioCopy(locale, "studio.outputs.filterAllKinds")}
            </option>
            {STUDIO_OUTPUT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {studioCopy(locale, `studio.outputs.kind.${kind}`)}
              </option>
            ))}
          </select>
        </div>
        <div className={styles["studio-output-filter-field"]}>
          <label htmlFor="studio-outputs-status">
            {studioCopy(locale, "studio.outputs.filterStatus")}
          </label>
          <select
            id="studio-outputs-status"
            name="status"
            className={styles["studio-output-filter-select"]}
            defaultValue={filters.status ?? ""}
          >
            <option value="">
              {studioCopy(locale, "studio.outputs.filterAllStatuses")}
            </option>
            {STUDIO_OUTPUT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {studioCopy(locale, OUTPUT_STATUS_COPY[status])}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={styles["studio-secondary-button"]}>
          {studioCopy(locale, "studio.outputs.filterApply")}
        </button>
        {filtered ? (
          <a
            className={styles["studio-output-filter-clear"]}
            href="/studio/outputs"
          >
            {studioCopy(locale, "studio.outputs.filterClear")}
          </a>
        ) : null}
      </form>

      {!parsed.success ? (
        <p className={styles["studio-notice"]} role="alert">
          {studioCopy(locale, "studio.outputs.filterInvalid")}
        </p>
      ) : null}

      {filtered && parsed.success ? (
        <p className={styles["studio-output-filter-summary"]} role="status">
          {studioCopy(locale, "studio.outputs.filterSummary")
            .replace("{count}", String(items.length))
            .replace("{query}", search)}
        </p>
      ) : null}

      <p className={styles["studio-pagination-summary"]} role="status">
        {renderStudioLine(locale, {
          key: "studio.pagination.summary",
          values: { page, count: items.length },
        })}
      </p>

      {newerHref !== null || earlierHref !== null ? (
        <nav
          className={styles["studio-pagination"]}
          aria-label={studioCopy(locale, "studio.pagination.label")}
        >
          {newerHref !== null ? (
            <Link className={styles["studio-evidence-link"]} href={newerHref}>
              {studioCopy(locale, "studio.outputs.newer")}
            </Link>
          ) : null}
          {earlierHref !== null ? (
            <Link className={styles["studio-evidence-link"]} href={earlierHref}>
              {studioCopy(locale, "studio.outputs.earlier")}
            </Link>
          ) : null}
        </nav>
      ) : null}

      {items.length === 0 ? (
        <>
          <p className={styles["studio-empty"]}>
            {offset > 0
              ? studioCopy(locale, "studio.pagination.emptyPage")
              : filtered
                ? studioCopy(locale, "studio.outputs.filteredEmpty")
                : studioCopy(locale, "studio.outputs.empty")}
          </p>
          <p className={styles["studio-notice"]}>
            {studioCopy(locale, "studio.outputs.emptyHint")}
          </p>
        </>
      ) : (
        <ul className={styles["studio-output-index"]}>
          {items.map((item) => (
            <li key={item.outputId}>
              <StudioOutputCard
                locale={locale}
                outputId={item.outputId}
                canSignOff={canSignOff}
                expandable
                initialSummary={{
                  kind: item.kind,
                  title: item.title,
                  status: toOutputStatus(item.status),
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
