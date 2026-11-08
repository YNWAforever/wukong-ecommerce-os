import { z } from "zod";

import type { Locale } from "../lib/locale";
import { merchantAuditPayloadSchema } from "../lib/studio/report-payload";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy } from "../lib/studio-copy";
import { formatHkDate } from "../lib/ui-copy";
import { StudioEvidence } from "./studio-evidence";
import styles from "./studio.module.css";

/**
 * The merchant/SEO audit report card (plan Task 11).
 *
 * Renders a persisted `merchant_audit` payload: listing counts by status, the
 * quality projection summary, recent export attempts, the evidence table and
 * the report's own limitations. Every table is data from the artifact; a
 * section whose source could not be read renders an explicit "could not be
 * read" line instead of an empty table or a zero.
 *
 * The export action is a plain link to the canonical JSON endpoint with the
 * previewed digest. It only appears once the artifact is `saved`/`signed_off`;
 * otherwise the card says the artifact must be saved first. The card never
 * signs off or approves anything by itself.
 */

const STATUS_LIKE = /^[a-z0-9_.-]{1,40}$/i;

function countRows(
  rows: ReadonlyArray<{ status: string; count: number }>,
): Array<{ status: string; count: number }> {
  return [...rows].sort((left, right) =>
    left.status.localeCompare(right.status),
  );
}

export type StudioReportCardProps = {
  readonly locale: Locale;
  /** A persisted `merchant_audit` payload; parsed defensively here. */
  readonly payload: unknown;
  /** Canonical JSON export link, or `null` while the artifact is not saved. */
  readonly exportHref: string | null;
};

export function StudioReportCard({
  locale,
  payload,
  exportHref,
}: StudioReportCardProps) {
  const parsed = merchantAuditPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return (
      <section
        className={styles["studio-report"]}
        data-state="invalid"
        aria-label={studioCopy(locale, "studio.report.title")}
      >
        <p className={styles["studio-review-invalid"]} role="status">
          {studioCopy(locale, "studio.report.invalidPayload")}
        </p>
      </section>
    );
  }
  const report = parsed.data;
  const period =
    report.period.from || report.period.to
      ? `${report.period.from ?? "…"} – ${report.period.to ?? "…"}`
      : studioCopy(locale, "studio.report.periodUnset");

  return (
    <section
      className={styles["studio-report"]}
      data-kind="merchant_audit"
      aria-label={studioCopy(locale, "studio.report.title")}
    >
      <header className={styles["studio-report-header"]}>
        <h4 className={styles["studio-report-title"]}>
          {studioCopy(locale, "studio.report.title")}
        </h4>
        <span className={styles["studio-report-badge"]}>
          {studioCopy(locale, "studio.report.scope")}
        </span>
      </header>

      <p className={styles["studio-report-meta"]}>
        <span>
          {renderStudioLine(locale, {
            key: "studio.report.period",
            values: { period },
          })}
        </span>
        <span>
          {renderStudioLine(locale, {
            key: "studio.report.asOf",
            values: { asOf: formatHkDate(report.asOf, locale) },
          })}
        </span>
      </p>

      <section className={styles["studio-report-section"]}>
        <h5 className={styles["studio-evidence-subtitle"]}>
          {studioCopy(locale, "studio.report.listingsTitle")}
        </h5>
        {report.listings === null ? (
          <p className={styles["studio-evidence-note"]}>
            {studioCopy(locale, "studio.report.unavailable")}
          </p>
        ) : (
          <div className={styles["studio-table-scroll"]}>
            <table className={styles["studio-report-table"]}>
              <thead>
                <tr>
                  <th scope="col">
                    {studioCopy(locale, "studio.report.status")}
                  </th>
                  <th scope="col">
                    {studioCopy(locale, "studio.report.count")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {countRows(report.listings).map((row) => (
                  <tr key={row.status} data-listing-status={row.status}>
                    <td>
                      {STATUS_LIKE.test(row.status) ? row.status : "unknown"}
                    </td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles["studio-report-section"]}>
        <h5 className={styles["studio-evidence-subtitle"]}>
          {studioCopy(locale, "studio.report.qualityTitle")}
        </h5>
        {report.quality === null ? (
          <p className={styles["studio-evidence-note"]}>
            {studioCopy(locale, "studio.report.unavailable")}
          </p>
        ) : (
          <p className={styles["studio-report-line"]}>
            {renderStudioLine(locale, {
              key: "studio.report.qualityLine",
              values: {
                totalListings: report.quality.totalListings,
                cleanCount: report.quality.cleanCount,
                hasGapsCount: report.quality.hasGapsCount,
                projectionState: report.quality.projectionState,
              },
            })}
          </p>
        )}
      </section>

      <section className={styles["studio-report-section"]}>
        <h5 className={styles["studio-evidence-subtitle"]}>
          {studioCopy(locale, "studio.report.exportsTitle")}
        </h5>
        {report.exports === null ? (
          <p className={styles["studio-evidence-note"]}>
            {studioCopy(locale, "studio.report.unavailable")}
          </p>
        ) : report.exports.length === 0 ? (
          <p className={styles["studio-evidence-note"]}>
            {studioCopy(locale, "studio.report.noExports")}
          </p>
        ) : (
          <div className={styles["studio-table-scroll"]}>
            <table className={styles["studio-report-table"]}>
              <thead>
                <tr>
                  <th scope="col">
                    {studioCopy(locale, "studio.report.attempt")}
                  </th>
                  <th scope="col">
                    {studioCopy(locale, "studio.report.status")}
                  </th>
                  <th scope="col">
                    {studioCopy(locale, "studio.report.rows")}
                  </th>
                  <th scope="col">
                    {studioCopy(locale, "studio.report.createdAt")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.exports.map((row) => (
                  <tr key={row.attemptId}>
                    <td>
                      <code className={styles["studio-review-field"]}>
                        {row.attemptId}
                      </code>
                    </td>
                    <td>{row.state}</td>
                    <td>{row.rowCount}</td>
                    <td>{formatHkDate(row.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <StudioEvidence
        locale={locale}
        checks={report.checks}
        coverage={report.coverage}
        headingLevel="h5"
      />

      {report.limitations.length > 0 ? (
        <ul className={styles["studio-turn-list"]}>
          {report.limitations.map((line, index) => (
            <li key={`${index}-${line.key}`}>
              {renderStudioLine(locale, line)}
            </li>
          ))}
        </ul>
      ) : null}

      <p className={styles["studio-report-note"]}>
        {studioCopy(locale, "studio.report.note")}
      </p>

      {exportHref === null ? (
        <p className={styles["studio-evidence-note"]}>
          {studioCopy(locale, "studio.report.exportNeedsSave")}
        </p>
      ) : (
        <a
          className={styles["studio-evidence-link"]}
          href={exportHref}
          download
        >
          {studioCopy(locale, "studio.report.export")}
        </a>
      )}
    </section>
  );
}

/** Guard used by callers that only pass a `kind` string. */
export function isMerchantAuditKind(kind: string): boolean {
  return z.literal("merchant_audit").safeParse(kind).success;
}
