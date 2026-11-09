import Link from "next/link";

import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy } from "../lib/studio-copy";
import { categoryMapProposalPayloadSchema } from "../lib/studio/category-map";
import styles from "./studio.module.css";

/**
 * Read-only category-map finding card (C1).
 *
 * It renders the persisted `finding` payload exactly as stored: the target
 * listing, an explicit unknown/known current category, suggestions with their
 * confidence and evidence refs, and the payload's own limitations. There is no
 * apply control and no optimistic claim; the only actions are a link to the
 * existing listing review screen and static evidence chips. The payload is
 * parsed defensively so a future payload version shows an honest unavailable
 * state instead of crashing the thread.
 */

export function StudioFindingCard({
  locale,
  payload,
}: {
  readonly locale: Locale;
  /** A persisted `finding` version payload; parsed here, never trusted. */
  readonly payload: unknown;
}) {
  const parsed = categoryMapProposalPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return (
      <section
        className={styles["studio-review"]}
        data-state="invalid"
        aria-label={studioCopy(locale, "studio.finding.title")}
      >
        <p className={styles["studio-review-invalid"]} role="status">
          {studioCopy(locale, "studio.finding.invalidPayload")}
        </p>
      </section>
    );
  }
  const finding = parsed.data;
  const listingHref = `/listings/${encodeURIComponent(finding.listingId)}`;
  return (
    <section
      className={styles["studio-review"]}
      data-kind="finding"
      data-finding-kind="category_map"
      aria-label={studioCopy(locale, "studio.finding.title")}
    >
      <header className={styles["studio-review-header"]}>
        <h4 className={styles["studio-review-title"]}>
          {studioCopy(locale, "studio.finding.title")}
        </h4>
        <span className={styles["studio-review-gate-badge"]}>
          {studioCopy(locale, "studio.finding.reviewNote")}
        </span>
      </header>

      <p className={styles["studio-review-meta"]}>
        <span>
          {studioCopy(locale, "studio.finding.listing").replace(
            "{listingId}",
            finding.listingId,
          )}
        </span>
        {finding.listingTitle ? <span>{finding.listingTitle}</span> : null}
        <span>
          {studioCopy(locale, "studio.finding.currentCategory")}:{" "}
          {finding.currentCategory ??
            studioCopy(locale, "studio.finding.unknown")}
        </span>
      </p>

      <div className={styles["studio-table-scroll"]}>
        {finding.suggestions.length === 0 ? (
          <p className={styles["studio-evidence-note"]}>
            {studioCopy(locale, "studio.finding.emptySuggestions")}
          </p>
        ) : (
          <table className={styles["studio-review-table"]}>
            <thead>
              <tr>
                <th scope="col">
                  {studioCopy(locale, "studio.finding.suggestionPath")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.finding.confidence")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.finding.evidence")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.finding.rationale")}
                </th>
              </tr>
            </thead>
            <tbody>
              {finding.suggestions.map((suggestion) => (
                <tr
                  key={suggestion.path}
                  data-suggestion-path={suggestion.path}
                >
                  <td>
                    <code className={styles["studio-review-field"]}>
                      {suggestion.path}
                    </code>
                  </td>
                  <td className={styles["studio-review-value"]}>
                    {Math.round(suggestion.confidence * 100)}% (
                    {suggestion.confidence})
                  </td>
                  <td>
                    <ul
                      className={styles["studio-review-chips"]}
                      aria-label={studioCopy(locale, "studio.finding.evidence")}
                    >
                      {suggestion.evidenceRefs.map((ref) => (
                        <li key={ref} className={styles["studio-review-chip"]}>
                          {ref}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className={styles["studio-review-value"]}>
                    {suggestion.rationale ??
                      studioCopy(locale, "studio.review.notAvailable")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {finding.limitations.length > 0 ? (
        <div className={styles["studio-review-limitations"]}>
          <h5 className={styles["studio-evidence-subtitle"]}>
            {studioCopy(locale, "studio.finding.limitations")}
          </h5>
          <ul className={styles["studio-turn-list"]}>
            {finding.limitations.map((limitation, index) => (
              <li key={`${index}-${limitation.key}`}>
                {renderStudioLine(locale, limitation)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className={styles["studio-review-not-applied"]}>
        {studioCopy(locale, "studio.finding.notApplied")}
      </p>
      <p className={styles["studio-review-note"]}>
        {studioCopy(locale, "studio.finding.reviewNote")}
      </p>

      <Link className={styles["studio-evidence-link"]} href={listingHref}>
        {studioCopy(locale, "studio.finding.openReview")}
      </Link>
    </section>
  );
}
