import Link from "next/link";

import type { SourceKind } from "@wukong/core";

import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import type {
  EvidenceCheck,
  EvidenceSource,
} from "../lib/studio/types";
import { formatHkDate } from "../lib/ui-copy";
import styles from "./studio.module.css";

/**
 * "From your records" evidence: coverage chips, the check → result table and
 * the source rows (design spec §2.3 step 3).
 *
 * The three honesty rules this component exists for:
 *
 *  - **missing is never zero.** A missing source renders the `Missing` chip and
 *    an explicit next-action note; it never renders `0`.
 *  - **unsupported is never "not connected".** The chip label says what the
 *    reply recorded, nothing about connectors.
 *  - **only same-origin paths or http(s) links are clickable.** A deep link is
 *    app data, but it is validated before becoming an anchor; anything else is
 *    dropped instead of being rendered as a link. External ancestors open in a
 *    new tab with `nofollow noopener noreferrer`.
 *
 * Sources are optional: the persisted reply stores coverage and checks, not
 * source rows, so a caller without them renders no source section rather than
 * claiming there were none.
 */

const COVERAGE_KEYS = {
  present: "studio.evidence.coverage.present",
  missing: "studio.evidence.coverage.missing",
  unsupported: "studio.evidence.coverage.unsupported",
} as const satisfies Record<string, StudioCopyKey>;

const CHECK_STATE_KEYS = {
  ok: "studio.evidence.checkState.ok",
  gap: "studio.evidence.checkState.gap",
  missing: "studio.evidence.checkState.missing",
  unsupported: "studio.evidence.checkState.unsupported",
} as const satisfies Record<EvidenceCheck["state"], StudioCopyKey>;

const SOURCE_KIND_KEYS = {
  listing: "studio.evidence.sourceKind.listing",
  catalog: "studio.evidence.sourceKind.catalog",
  quality: "studio.evidence.sourceKind.quality",
  source_import: "studio.evidence.sourceKind.source_import",
  export_attempt: "studio.evidence.sourceKind.export_attempt",
  job: "studio.evidence.sourceKind.job",
  audit: "studio.evidence.sourceKind.audit",
  website: "studio.evidence.sourceKind.website",
  workbook: "studio.evidence.sourceKind.workbook",
  shopline_projection: "studio.evidence.sourceKind.shopline_projection",
} as const satisfies Record<SourceKind, StudioCopyKey>;

export type StudioSafeLink = {
  readonly href: string;
  readonly external: boolean;
};

/**
 * Validate a persisted deep link before it becomes an anchor.
 *
 * Only a same-origin absolute path (`/...`, not protocol-relative `//...`) or
 * an `http(s)` URL is accepted. `javascript:`, `data:`, relative paths and
 * anything malformed return `null`, so a bad row renders as text instead of an
 * executable link.
 */
export function safeStudioDeepLink(
  href: string | null | undefined,
): StudioSafeLink | null {
  if (typeof href !== "string" || href.length === 0 || href.length > 500)
    return null;
  if (href.startsWith("//")) return null;
  if (href.startsWith("/")) return { href, external: false };
  if (/^https?:\/\//i.test(href)) return { href, external: true };
  return null;
}

function derivedCheckLink(check: EvidenceCheck): StudioSafeLink | null {
  const listingId =
    typeof check.values.listingId === "string" ? check.values.listingId : null;
  switch (check.key) {
    case "studio.check.listing_status":
    case "studio.check.content_gap":
      return listingId
        ? safeStudioDeepLink(`/listings/${encodeURIComponent(listingId)}`)
        : null;
    case "studio.check.quality_summary":
      return safeStudioDeepLink("/quality");
    case "studio.check.recent_jobs":
      return safeStudioDeepLink("/jobs");
    case "studio.check.catalog_matches":
      return safeStudioDeepLink("/dashboard");
    default:
      return null;
  }
}

function SourceLink({
  locale,
  link,
}: {
  locale: Locale;
  link: StudioSafeLink;
}) {
  const label = studioCopy(locale, "studio.evidence.openSource");
  if (link.external) {
    return (
      <a
        className={styles["studio-evidence-link"]}
        href={link.href}
        target="_blank"
        rel="nofollow noopener noreferrer"
      >
        {label}
      </a>
    );
  }
  return (
    <Link className={styles["studio-evidence-link"]} href={link.href}>
      {label}
    </Link>
  );
}

export type StudioEvidenceProps = {
  readonly locale: Locale;
  readonly checks: readonly EvidenceCheck[];
  readonly coverage: Readonly<Record<string, "present" | "missing" | "unsupported">>;
  readonly sources?: readonly EvidenceSource[];
  readonly headingLevel?: "h3" | "h4" | "h5";
};

export function StudioEvidence({
  locale,
  checks,
  coverage,
  sources,
  headingLevel = "h3",
}: StudioEvidenceProps) {
  const coverageEntries = Object.entries(coverage);
  const hasMissing =
    coverageEntries.some(([, value]) => value === "missing") ||
    checks.some((check) => check.state === "missing");
  const Heading = headingLevel;

  return (
    <section
      className={styles["studio-evidence"]}
      aria-label={studioCopy(locale, "studio.evidence.title")}
    >
      <Heading className={styles["studio-evidence-title"]}>
        {studioCopy(locale, "studio.evidence.title")}
      </Heading>

      {coverageEntries.length > 0 ? (
        <ul
          className={styles["studio-coverage"]}
          aria-label={studioCopy(locale, "studio.evidence.title")}
        >
          {coverageEntries.map(([kind, value]) => (
            <li
              key={kind}
              className={styles["studio-coverage-chip"]}
              data-coverage={value}
            >
              <span>
                {(SOURCE_KIND_KEYS as Record<string, StudioCopyKey>)[kind]
                  ? studioCopy(
                      locale,
                      (SOURCE_KIND_KEYS as Record<string, StudioCopyKey>)[
                        kind
                      ]!,
                    )
                  : kind}
              </span>
              <strong>{studioCopy(locale, COVERAGE_KEYS[value])}</strong>
            </li>
          ))}
        </ul>
      ) : null}

      {hasMissing ? (
        <p className={styles["studio-evidence-missing"]}>
          {studioCopy(locale, "studio.evidence.missingAction")}
        </p>
      ) : null}

      {checks.length > 0 ? (
        <table className={styles["studio-check-table"]}>
          <caption className={styles["studio-visually-hidden"]}>
            {studioCopy(locale, "studio.evidence.checks")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{studioCopy(locale, "studio.evidence.check")}</th>
              <th scope="col">
                {studioCopy(locale, "studio.evidence.result")}
              </th>
              <th scope="col">{studioCopy(locale, "studio.evidence.sources")}</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check, index) => {
              const link = derivedCheckLink(check);
              return (
                <tr
                  key={`${index}-${check.key}`}
                  data-state={check.state}
                  data-check={check.key}
                >
                  <td>{renderStudioLine(locale, check)}</td>
                  <td>
                    <span
                      className={styles["studio-check-state"]}
                      data-state={check.state}
                    >
                      {studioCopy(locale, CHECK_STATE_KEYS[check.state])}
                    </span>
                  </td>
                  <td>{link ? <SourceLink locale={locale} link={link} /> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {sources !== undefined ? (
        <div className={styles["studio-evidence-sources"]}>
          <h4 className={styles["studio-evidence-subtitle"]}>
            {studioCopy(locale, "studio.evidence.sources")}
          </h4>
          {sources.length === 0 ? (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.evidence.noSources")}
            </p>
          ) : (
            <ul className={styles["studio-source-list"]}>
              {sources.map((source) => {
                const link = source.restricted
                  ? null
                  : safeStudioDeepLink(source.deepLink);
                return (
                  <li
                    key={source.ref}
                    className={styles["studio-source"]}
                    data-restricted={source.restricted ? "true" : "false"}
                  >
                    <span className={styles["studio-source-kind"]}>
                      {studioCopy(locale, SOURCE_KIND_KEYS[source.kind])}
                    </span>
                    <span className={styles["studio-source-label"]}>
                      {source.restricted
                        ? studioCopy(locale, "studio.evidence.restricted")
                        : source.label}
                    </span>
                    <span
                      className={styles["studio-coverage-chip"]}
                      data-coverage={source.coverage}
                    >
                      {studioCopy(locale, COVERAGE_KEYS[source.coverage])}
                    </span>
                    <span className={styles["studio-source-meta"]}>
                      {formatHkDate(source.asOf, locale)}
                      {source.version ? ` · v${source.version}` : ""}
                    </span>
                    {link ? <SourceLink locale={locale} link={link} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
