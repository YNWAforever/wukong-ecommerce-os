import type { Locale } from "../lib/locale";
import { gapReportPayloadSchema } from "../lib/studio/report-payload";
import { guidedCopy } from "../lib/studio/guided-copy";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy } from "../lib/studio-copy";
import { formatHkDate } from "../lib/ui-copy";
import { StudioEvidence } from "./studio-evidence";
import styles from "./studio.module.css";
export function StudioGapReportCard({
  locale,
  payload,
}: {
  locale: Locale;
  payload: unknown;
}) {
  const parsed = gapReportPayloadSchema.safeParse(payload);
  if (!parsed.success)
    return (
      <p role="status">{studioCopy(locale, "studio.report.invalidPayload")}</p>
    );
  const report = parsed.data;
  return (
    <section
      className={styles["studio-report"]}
      data-kind="gap_report"
      aria-label={guidedCopy(locale, "gapTitle")}
    >
      <h4>{guidedCopy(locale, "gapTitle")}</h4>
      <p>
        {guidedCopy(
          locale,
          report.scope.mode === "selected" ? "gap_review" : "sample",
        )}{" "}
        · {formatHkDate(report.asOf, locale)}
      </p>
      {report.listings === null ? (
        <p>{guidedCopy(locale, "unknown")}</p>
      ) : (
        <dl>
          {report.listings.map((row) => (
            <div key={row.listingId}>
              <dt>
                <a href={`/listings/${encodeURIComponent(row.listingId)}`}>
                  {row.title ?? guidedCopy(locale, "selected")}
                </a>{" "}
                ·{" "}
                {row.activeVersion
                  ? `v${row.activeVersion.sequence}`
                  : guidedCopy(locale, "noVersion")}
              </dt>
              <dd>
                {row.gaps === null ? (
                  guidedCopy(locale, "unknown")
                ) : row.gaps.length === 0 ? (
                  guidedCopy(locale, "noGaps")
                ) : (
                  <ul>
                    {row.gaps.map((gap, i) => (
                      <li key={`${gap.code}-${i}`}>{gap.code}</li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {report.scope.truncated || report.evidenceTruncated ? (
        <p>{guidedCopy(locale, "more")}</p>
      ) : null}
      <StudioEvidence
        locale={locale}
        checks={report.checks}
        coverage={report.coverage}
        headingLevel="h5"
      />
      {report.limitations.length > 0 ? (
        <ul>
          {report.limitations.map((line, i) => (
            <li key={`${line.key}-${i}`}>{renderStudioLine(locale, line)}</li>
          ))}
        </ul>
      ) : null}
      <p>{studioCopy(locale, "studio.report.note")}</p>
    </section>
  );
}
