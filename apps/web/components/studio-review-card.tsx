"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import {
  copyProposalPayloadSchema,
  type CopyProposalField,
  formatProposedValues,
} from "../lib/studio/copy-proposal";
import { copyTextToClipboard } from "../lib/studio/clipboard";
import { studioCopy } from "../lib/studio-copy";
import { formatHkDate } from "../lib/ui-copy";
import styles from "./studio.module.css";

export { copyProposalPayloadSchema };
export type { CopyProposalField };

/**
 * The copy-proposal review card (plan Task 9, design spec §2.3 step 5 + B2).
 *
 * It renders a persisted proposal exactly as stored: a `check → proposed`
 * table, the evidence refs each proposed value cites, the proposal's own
 * limitations, and an explicit "requires human approval" gate. The rules it
 * keeps:
 *
 *  - **proposal only, no write authority.** There is no approve/apply control;
 *    copying puts text on the clipboard and the link opens the existing
 *    listing review screen where a person can act. The card says explicitly
 *    that the proposal is not applied and never writes canonical data.
 *  - **copy is honest.** Per-field and all-field copy report the clipboard
 *    write's actual result; a refusal shows an error instead of "copied".
 *  - **exports are gated.** JSON and PDF links exist only for a saved or
 *    signed-off artifact, carry the latest published digest the caller
 *    previewed, and otherwise show a disabled control plus "save before
 *    exporting" — there is no optimistic export claim.
 *  - **no invented labels.** A field is rendered by its stored id (`sku`,
 *    `title.en`) in monospace.
 *  - **evidence refs are refs, not links.** They identify rows in the evidence
 *    pack; they are not URLs and are rendered as non-interactive chips.
 *
 * The payload is parsed defensively: a version written by a newer deployment
 * renders an honest unavailable state instead of crashing the card.
 */

export type StudioReviewExport = {
  readonly outputId: string;
  readonly status: "draft" | "saved" | "signed_off" | "discarded";
  /** The version's `contentDigest`, i.e. the latest published digest. */
  readonly digest: string;
  /** New links pin the exact preview; omitted only by historical callers. */
  readonly revision?: number;
};

export type StudioReviewCardProps = {
  readonly locale: Locale;
  /** A persisted tool version payload; parsed here, never trusted as typed. */
  readonly payload: unknown;
  /**
   * Export context from the owning output card. Absent when the card is
   * rendered without a persisted artifact identity.
   */
  readonly exportInfo?: StudioReviewExport | null;
};

function exportable(status: StudioReviewExport["status"] | undefined): boolean {
  return status === "saved" || status === "signed_off";
}

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

export function StudioReviewCard({
  locale,
  payload,
  exportInfo = null,
}: StudioReviewCardProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = useCallback(async (text: string, marker: string) => {
    const ok = await copyTextToClipboard(text);
    setCopied(ok ? marker : null);
    setCopyFailed(!ok);
  }, []);

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
  const canExport = exportable(exportInfo?.status);
  const exportBase = exportInfo
    ? `/api/studio/outputs/${encodeURIComponent(exportInfo.outputId)}/export?digest=${encodeURIComponent(exportInfo.digest)}`
    : null;
  const listingHref = `/listings/${encodeURIComponent(proposal.listingId)}${
    exportInfo
      ? `?studioOutput=${encodeURIComponent(exportInfo.outputId)}${exportInfo.revision ? `&studioRevision=${exportInfo.revision}&studioDigest=${encodeURIComponent(exportInfo.digest)}` : ""}`
      : ""
  }`;

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
                    <span>{valueOrUnavailable(locale, field.proposed)}</span>
                    <button
                      type="button"
                      className={styles["studio-review-copy"]}
                      aria-label={`${studioCopy(locale, "studio.review.copyProposed")}: ${field.field}`}
                      onClick={() => void copy(field.proposed, field.field)}
                    >
                      {studioCopy(locale, "studio.review.copyProposed")}
                    </button>
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
                          <li
                            key={ref}
                            className={styles["studio-review-chip"]}
                          >
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

      {proposal.fields.length > 0 ? (
        <div className={styles["studio-review-actions"]}>
          <button
            type="button"
            className={styles["studio-review-copy-all"]}
            onClick={() =>
              void copy(
                formatProposedValues(proposal.fields),
                "all-proposed-values",
              )
            }
          >
            {studioCopy(locale, "studio.review.copyAll")}
          </button>
          <p className={styles["studio-review-copy-status"]} role="status">
            {copyFailed
              ? studioCopy(locale, "studio.review.copyFailed")
              : copied !== null
                ? studioCopy(locale, "studio.review.copied")
                : ""}
          </p>
        </div>
      ) : null}

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

      <p className={styles["studio-review-not-applied"]}>
        {studioCopy(locale, "studio.review.notApplied")}
      </p>
      <p className={styles["studio-review-note"]}>
        {studioCopy(locale, "studio.review.noCanonicalWrite")}
      </p>

      <div className={styles["studio-review-export"]}>
        <h5 className={styles["studio-evidence-subtitle"]}>
          {studioCopy(locale, "studio.review.exportTitle")}
        </h5>
        {canExport && exportBase && exportInfo ? (
          <>
            <div className={styles["studio-review-export-links"]}>
              <a
                className={styles["studio-review-export-link"]}
                href={`${exportBase}&format=json`}
                download
              >
                {studioCopy(locale, "studio.review.exportJson")}
              </a>
              <a
                className={styles["studio-review-export-link"]}
                href={`${exportBase}&format=pdf`}
                download
              >
                {studioCopy(locale, "studio.review.exportPdf")}
              </a>
            </div>
            <p className={styles["studio-review-export-note"]}>
              {studioCopy(locale, "studio.review.exportSavedOnly")}
            </p>
          </>
        ) : (
          <>
            <div className={styles["studio-review-export-links"]}>
              <button
                type="button"
                className={styles["studio-review-export-link"]}
                disabled
              >
                {studioCopy(locale, "studio.review.exportJson")}
              </button>
              <button
                type="button"
                className={styles["studio-review-export-link"]}
                disabled
              >
                {studioCopy(locale, "studio.review.exportPdf")}
              </button>
            </div>
            <p className={styles["studio-review-export-note"]}>
              {studioCopy(locale, "studio.review.saveBeforeExport")}
            </p>
          </>
        )}
      </div>

      <Link className={styles["studio-evidence-link"]} href={listingHref}>
        {studioCopy(locale, "studio.review.openReview")}
      </Link>
    </section>
  );
}
