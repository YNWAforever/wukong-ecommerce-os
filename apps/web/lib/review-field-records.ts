import { createHash } from "node:crypto";

import type { FieldEvidence, ReviewableListing } from "@wukong/core";
import type { ReviewFieldRecords } from "@wukong/db";

import { REVIEW_FIELD_BINDINGS } from "./review-field-bindings";

/**
 * sha256 hex of a JSON encoding. One encoding for before and after, so for a
 * text field equal digests mean identical code points. Nothing is
 * Unicode-normalised: folding full-width punctuation or CJK compatibility
 * ideographs would hide a difference a storefront visibly shows.
 */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type ReviewFieldRecordsInput = {
  content: ReviewableListing;
  evidence: readonly FieldEvidence[];
  /**
   * The imported row, keyed by bulk-form column key. `null` for a listing that
   * was never imported.
   */
  rawRow: Readonly<Record<string, string | null>> | null;
};

/**
 * What each confirmation field is being confirmed against, as digests.
 *
 * Server-only: it hashes with `node:crypto`. Every input comes from rows the
 * caller does not control -- the confirmed version, its evidence and the
 * imported row -- so nothing here can be supplied by a request.
 *
 * For the seven text fields, `before.digest === afterDigest` means the
 * confirmed value is the merchant's cell exactly, ignoring leading and trailing
 * whitespace. `seoKeywords` is the exception: its cell is a joined string and
 * its content an array, so its `before` records provenance only and its
 * digests are never comparable. Splitting the cell back into an array is not
 * safe -- joining is not injective, which is why the array is digested.
 */
export function buildReviewFieldRecords(
  input: ReviewFieldRecordsInput,
): ReviewFieldRecords {
  const records: ReviewFieldRecords = {};
  for (const [key, binding] of Object.entries(REVIEW_FIELD_BINDINGS)) {
    const cell = input.rawRow?.[key] ?? null;
    // Each entry encoded on its own and sorted: the snapshot reads evidence
    // with no ORDER BY, and the same grounding in a different order must not
    // look changed.
    const grounding = input.evidence
      .filter((entry) => entry.field === binding.evidenceKey)
      .map(({ sourceAssetId, page, excerpt, confidence }) =>
        JSON.stringify({ sourceAssetId, page, excerpt, confidence }),
      )
      .sort();
    records[key] = {
      afterDigest: digest(binding.read(input.content)),
      // Trimmed before digesting: content is stored through z.string().trim(),
      // so a padded cell the merchant never changed would otherwise read as
      // changed. Interior whitespace is kept -- content allows it, and
      // collapsing it could hide a real edit.
      before:
        cell === null || cell.trim() === ""
          ? null
          : { column: key, digest: digest(cell.trim()) },
      evidenceDigest: grounding.length === 0 ? null : digest(grounding),
    };
  }
  return records;
}
