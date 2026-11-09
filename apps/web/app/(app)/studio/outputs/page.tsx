import { cookies } from "next/headers";

import {
  StudioOutputCard,
  toOutputStatus,
} from "../../../../components/studio-output-card";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import {
  STUDIO_OUTPUT_KINDS,
  STUDIO_OUTPUT_STATUSES,
  studioOutputListQuerySchema,
} from "../../../../lib/studio/contracts";
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
  }>;
}) {
  const params = await searchParams;
  const candidate: Record<string, string> = {};
  for (const key of ["q", "kind", "status"] as const) {
    const value = firstParam(params[key]);
    if (value !== null && value.length > 0) candidate[key] = value;
  }
  const parsed = studioOutputListQuerySchema.safeParse(candidate);
  const filters = parsed.success ? parsed.data : {};
  const search = filters.q?.trim() ?? "";
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
            .replace("{count}", String(listed.items.length))
            .replace("{query}", search)}
        </p>
      ) : null}

      {listed.truncated ? (
        <p className={styles["studio-notice"]}>
          {studioCopy(locale, "studio.outputs.truncated")}
        </p>
      ) : null}

      {listed.items.length === 0 ? (
        <>
          <p className={styles["studio-empty"]}>
            {filtered
              ? studioCopy(locale, "studio.outputs.filteredEmpty")
              : studioCopy(locale, "studio.outputs.empty")}
          </p>
          <p className={styles["studio-notice"]}>
            {studioCopy(locale, "studio.outputs.emptyHint")}
          </p>
        </>
      ) : (
        <ul className={styles["studio-output-index"]}>
          {listed.items.map((item) => (
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
