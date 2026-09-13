import { createHash } from "node:crypto";

import type { FieldEvidence, ReviewableListing } from "@wukong/core";
import type { ReviewFieldRecords } from "@wukong/db";

import { REVIEW_FIELD_BINDINGS } from "./review-field-bindings";

/**
 * sha256 hex of a JSON encoding. One encoding for before and after, so equal
 * digests mean equal values.
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
      before:
        cell === null || cell.trim() === ""
          ? null
          : { column: key, digest: digest(cell) },
      evidenceDigest: grounding.length === 0 ? null : digest(grounding),
    };
  }
  return records;
}
