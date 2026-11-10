import Link from "next/link";

import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import { categoryMapProposalPayloadSchema } from "../lib/studio/category-map";
import {
  supplierIntelProposalPayloadSchema,
  type SupplierFieldKey,
  type SupplierIntelProposalPayload,
} from "../lib/studio/supplier-intel";
import styles from "./studio.module.css";

/**
 * Read-only persisted `finding` card (C1).
 *
 * It renders the payload exactly as stored for each reviewed finding version:
 * the category-map proposal (listing, explicit known/unknown current category,
 * suggestions with confidence and evidence refs) and the supplier-intel finding
 * (field values quoted from the linked workbook row, explicit unknown fields).
 * There is no apply control and no optimistic claim; the only actions are a link
 * to the existing listing review screen and static evidence chips. The payload is
 * parsed defensively so a future payload version shows an honest unavailable
 * state instead of crashing the thread.
 */

const SUPPLIER_FIELD_LABEL_KEYS = {
  supplier: "studio.supplierField.supplier",
  brand: "studio.supplierField.brand",
  sku: "studio.supplierField.sku",
  barcode: "studio.supplierField.barcode",
  mpn: "studio.supplierField.mpn",
  productCost: "studio.supplierField.productCost",
  tradePrice: "studio.supplierField.tradePrice",
} as const satisfies Record<SupplierFieldKey, StudioCopyKey>;

export function StudioFindingCard({
  locale,
  payload,
}: {
  readonly locale: Locale;
  /** A persisted `finding` version payload; parsed here, never trusted. */
  readonly payload: unknown;
}) {
  const supplier = supplierIntelProposalPayloadSchema.safeParse(payload);
  if (supplier.success) {
    return <SupplierFinding locale={locale} finding={supplier.data} />;
  }
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

function SupplierFinding({
  locale,
  finding,
}: {
  readonly locale: Locale;
  readonly finding: SupplierIntelProposalPayload;
}) {
  const listingHref = `/listings/${encodeURIComponent(finding.listingId)}`;
  const missingFields = finding.missingFields
    .map((field) => studioCopy(locale, SUPPLIER_FIELD_LABEL_KEYS[field]))
    .join(", ");
  return (
    <section
      className={styles["studio-review"]}
      data-kind="finding"
      data-finding-kind="supplier_intel"
      aria-label={studioCopy(locale, "studio.finding.supplierTitle")}
    >
      <header className={styles["studio-review-header"]}>
        <h4 className={styles["studio-review-title"]}>
          {studioCopy(locale, "studio.finding.supplierTitle")}
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
        <span>{studioCopy(locale, "studio.finding.supplierMeta")}</span>
      </p>

      <div className={styles["studio-table-scroll"]}>
        {finding.fields.length === 0 ? (
          <p className={styles["studio-evidence-note"]}>
            {studioCopy(locale, "studio.finding.emptySuggestions")}
          </p>
        ) : (
          <table className={styles["studio-review-table"]}>
            <thead>
              <tr>
                <th scope="col">
                  {studioCopy(locale, "studio.finding.field")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.finding.value")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.finding.evidence")}
                </th>
              </tr>
            </thead>
            <tbody>
              {finding.fields.map((field) => (
                <tr key={field.field} data-supplier-field={field.field}>
                  <th scope="row" className={styles["studio-review-field"]}>
                    {studioCopy(locale, SUPPLIER_FIELD_LABEL_KEYS[field.field])}
                  </th>
                  <td className={styles["studio-review-value"]}>
                    {field.value}
                  </td>
                  <td>
                    <ul
                      className={styles["studio-review-chips"]}
                      aria-label={studioCopy(locale, "studio.finding.evidence")}
                    >
                      {field.evidenceRefs.map((ref) => (
                        <li key={ref} className={styles["studio-review-chip"]}>
                          {ref}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {missingFields.length > 0 ? (
        <p className={styles["studio-review-meta"]}>
          {renderStudioLine(locale, {
            key: "studio.finding.missingFields",
            values: { fields: missingFields },
          })}
        </p>
      ) : null}

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
        {studioCopy(locale, "studio.finding.supplierNotApplied")}
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
