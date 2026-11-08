import Link from "next/link";
import { z } from "zod";

import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy } from "../lib/studio-copy";
import { formatHkDate } from "../lib/ui-copy";
import styles from "./studio.module.css";

/**
 * The copy-proposal review card (plan Task 9, design spec §2.3 step 5).
 *
 * It renders a persisted proposal exactly as stored: a `check → proposed`
 * table, the evidence refs each proposed value cites, the proposal's own
 * limitations, and an explicit "requires human approval" gate. Three rules it
 * exists to keep:
 *
 *  - **proposal only, no write authority.** There is no approve/apply control;
 *    the only action is a link to the existing listing review screen where a
 *    person can act. The copy says the proposal never writes canonical data.
 *  - **no invented labels.** A field is rendered by its stored id (`sku`,
 *    `title.en`) in monospace. Prettifying "title.en" into "English title"
 *    would be a translation decision this card has no basis to make.
 *  - **evidence refs are refs, not links.** They identify rows in the evidence
 *    pack; they are not URLs and are rendered as non-interactive chips so they
 *    cannot look clickable or be used as navigation.
 *
 * The payload is parsed defensively: a version written by a newer deployment
 * renders an honest unavailable state instead of crashing the thread.
 */

const proposalFieldSchema = z.object({
  field: z.string().min(1).max(200),
  /** The persisted current value for the field; null means genuinely absent. */
  current: z.string().max(4000).nullable(),
  proposed: z.string().min(1).max(4000),
  evidenceRefs: z.array(z.string().min(1).max(200)).max(20),
});

export const copyProposalPayloadSchema = z.object({
  listingId: z.string().min(1).max(200),
  activeVersionId: z.string().min(1).max(200),
  activeVersionSequence: z.number().int().min(0),
  fields: z.array(proposalFieldSchema).max(60),
  limitations: z.array(z.string().max(500)).max(20).default([]),
  asOf: z.string().min(1).max(64),
});
export type CopyProposalPayload = z.infer<typeof copyProposalPayloadSchema>;

export type StudioReviewCardProps = {
  readonly locale: Locale;
  /** A persisted tool version payload; parsed here, never trusted as typed. */
  readonly payload: unknown;
};

function valueOrUnavailable(locale: Locale, value: string | null | undefined) {
  if (typeof value !== "string" || value.length === 0) {
    return (
      <span className={styles["studio-review-unavailable"]}>
        {studioCopy(locale, "studio.review.notAvailable")}
      </span>
    );
  }
  return value;
}

export function StudioReviewCard({ locale, payload }: StudioReviewCardProps) {
  const parsed = copyProposalPayloadSchema.safeParse(payload);

  if (!parsed.success) {
    return (
      <section
        className={styles["studio-review"]}
        data-state="invalid"
        aria-label={studioCopy(locale, "studio.review.title")}
      >
        <p className={styles["studio-review-invalid"]} role="status">
          {studioCopy(locale, "studio.review.invalidPayload")}
        </p>
      </section>
    );
  }

  const proposal = parsed.data;
  const listingHref = `/listings/${encodeURIComponent(proposal.listingId)}`;

  return (
    <section
      className={styles["studio-review"]}
      data-kind="copy_proposal"
      aria-label={studioCopy(locale, "studio.review.title")}
    >
      <header className={styles["studio-review-header"]}>
        <h4 className={styles["studio-review-title"]}>
          {studioCopy(locale, "studio.review.title")}
        </h4>
        <span className={styles["studio-review-gate-badge"]}>
          {studioCopy(locale, "studio.review.approvalGate")}
        </span>
      </header>

      <p className={styles["studio-review-meta"]}>
        <span>
          {renderStudioLine(locale, {
            key: "studio.review.listing",
            values: { listingId: proposal.listingId },
          })}
        </span>
        <span>
          {renderStudioLine(locale, {
            key: "studio.review.activeVersion",
            values: { version: proposal.activeVersionSequence },
          })}
        </span>
        <span>
          {renderStudioLine(locale, {
            key: "studio.review.asOf",
            values: { asOf: formatHkDate(proposal.asOf, locale) },
          })}
        </span>
      </p>

      <div className={styles["studio-table-scroll"]}>
        {proposal.fields.length === 0 ? (
          <p className={styles["studio-evidence-note"]}>
            {studioCopy(locale, "studio.review.noFields")}
          </p>
        ) : (
          <table className={styles["studio-review-table"]}>
            <thead>
              <tr>
                <th scope="col">
                  {studioCopy(locale, "studio.review.table.field")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.review.table.current")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.review.table.proposed")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.review.table.evidence")}
                </th>
              </tr>
            </thead>
            <tbody>
              {proposal.fields.map((field, index) => (
                <tr
                  key={`${index}-${field.field}`}
                  data-field={field.field}
                  data-proposal-row="true"
                >
                  <td>
                    <code className={styles["studio-review-field"]}>
                      {field.field}
                    </code>
                  </td>
                  <td className={styles["studio-review-value"]}>
                    {valueOrUnavailable(locale, field.current)}
                  </td>
                  <td
                    className={`${styles["studio-review-value"]} ${styles["studio-review-proposed"]}`}
                  >
                    {valueOrUnavailable(locale, field.proposed)}
                  </td>
                  <td>
                    {field.evidenceRefs.length === 0 ? (
                      <span className={styles["studio-review-unavailable"]}>
                        {studioCopy(locale, "studio.review.evidenceNone")}
                      </span>
                    ) : (
                      <ul
                        className={styles["studio-review-chips"]}
                        aria-label={studioCopy(
                          locale,
                          "studio.review.table.evidence",
                        )}
                      >
                        {field.evidenceRefs.map((ref) => (
                          <li key={ref} className={styles["studio-review-chip"]}>
                            {ref}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {proposal.limitations.length > 0 ? (
        <div className={styles["studio-review-limitations"]}>
          <h5 className={styles["studio-evidence-subtitle"]}>
            {studioCopy(locale, "studio.review.limitations")}
          </h5>
          <ul className={styles["studio-turn-list"]}>
            {proposal.limitations.map((limitation, index) => (
              <li key={`${index}-${limitation.slice(0, 24)}`}>{limitation}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className={styles["studio-review-note"]}>
        {studioCopy(locale, "studio.review.noCanonicalWrite")}
      </p>

      <Link className={styles["studio-evidence-link"]} href={listingHref}>
        {studioCopy(locale, "studio.review.openReview")}
      </Link>
    </section>
  );
}
