import type {
  ListingRepository,
  PlatformProductRepository,
  ReviewConfirmationRepository,
  SourceImportRepository,
} from "@wukong/db";
import type { CanonicalListing } from "@wukong/core";
import {
  createBulkFormUpdate,
  hashBulkFormHeaderContract,
  isBulkFormRawRow,
  ShoplineBulkFormError,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
  type BulkFormEnrichment,
  type BulkFormExportRow,
} from "@wukong/shopline";
import {
  writeBulkFormWorkbook,
  readBulkFormSheet,
} from "@wukong/shopline/bulk-form-xlsx";

import {
  checkBulkUpdateEligibility,
  type BulkUpdateEligibilityDeps,
  type BulkUpdateEligibilityReason,
  type BulkUpdateEvidence,
  type BulkUpdateLink,
} from "./bulk-update-eligibility";

// Both Bulk Update entry points use this decision and workbook builder.
export type ExportManifestOutcome =
  | "included"
  | "excluded_no_op"
  | "excluded_stale"
  | "excluded_unapproved"
  | "excluded_blocked"
  | "excluded_unconfirmed"
  | "not_import_origin"
  | "raw_row_invalid"
  | "listing_not_found";

export type ExportManifestEntry = {
  listingId: string;
  versionId: string | null;
  outcome: ExportManifestOutcome;
  reason?: BulkUpdateEligibilityReason;
};

export type CreateBulkExportInput = {
  workspaceId: string;
  requestedBy: string;
  listingIds: readonly string[];
  freshnessAttested: boolean;
};

/**
 * A superset of `content-freshness.ts`'s `PlatformProductLink` — carries the
 * extra fields (`remoteProductId`, `rawRow`, `origin`, `connectionId`) this
 * orchestration needs beyond what the freshness gate itself reads.
 * Structurally assignable wherever `PlatformProductLink` is expected.
 */
export type BulkExportPlatformProductLink = BulkUpdateLink;

/** Only the content fields consumed by the existing Bulk Update writer. */
export type BulkExportListingContent = Pick<
  CanonicalListing,
  "title" | "description" | "seo" | "tags"
>;

export type CreateBulkExportDeps = BulkUpdateEligibilityDeps & {
  getActiveVersion(
    listingId: string,
  ): Promise<{ id: string; content: BulkExportListingContent } | null>;
};

export type CreateBulkExportResult = {
  manifest: ExportManifestEntry[];
  evidence: BulkUpdateEvidence[];
  /** Count of listings actually written into the sheet — not raw cell-change count. */
  rowCount: number;
  specVersion: string;
  body: Uint8Array;
};

/**
 * Compares a reparsed workbook grid against the sheet `createBulkFormUpdate`
 * intended to write. Two normalizations are needed, or this would spuriously
 * fail on every export that has a blank trailing cell:
 *
 * - `readBulkFormSheet` returns `null` for a blank cell (the inline
 *   null-for-blank logic in `packages/shopline/src/bulk-form-xlsx.ts`'s own
 *   `readBulkFormSheet`, around lines 222-234), while `BulkFormUpdate.sheet`'s
 *   blanks are `""` -- both sides are normalized to `""` before comparing.
 * - `writeBulkFormWorkbook`'s `worksheetXml` omits the `<c>` element entirely
 *   for a blank cell (`bulk-form-xlsx.ts`'s `if (value.length === 0) return
 *   "";`), so a row whose TRAILING cell(s) are blank -- e.g. the locked,
 *   never-enriched `slKey1` column, which is last in `BULK_FORM_COLUMNS` --
 *   round-trips to a shorter array than it was written with. That is correct
 *   reader/writer behavior, not corruption, so row width is compared as the
 *   max of the two lengths rather than requiring exact length equality; an
 *   unexpected non-blank value on either side still fails the per-column
 *   comparison below.
 */
export function sheetsMatch(
  reparsed: readonly (readonly (string | null)[])[],
  intended: readonly (readonly string[])[],
): boolean {
  if (reparsed.length !== intended.length) return false;
  for (let row = 0; row < intended.length; row += 1) {
    const reparsedRow = reparsed[row] ?? [];
    const intendedRow = intended[row] ?? [];
    const width = Math.max(reparsedRow.length, intendedRow.length);
    for (let col = 0; col < width; col += 1) {
      if ((reparsedRow[col] ?? "") !== (intendedRow[col] ?? "")) return false;
    }
  }
  return true;
}

export async function createBulkExport(
  input: CreateBulkExportInput,
  deps: CreateBulkExportDeps,
): Promise<CreateBulkExportResult> {
  const manifest: ExportManifestEntry[] = [];
  const evidence: BulkUpdateEvidence[] = [];
  const rows: BulkFormExportRow[] = [];
  const enrichments: BulkFormEnrichment[] = [];
  // listingId -> remoteProductId, for the listings that made it into `rows`.
  const survivorRemoteProductIds = new Map<string, string>();
  // The connectionId of the first import-origin listing seen, so every
  // subsequent import-origin listing can be checked against it.
  let sharedConnectionId: string | null = null;

  for (const listingId of input.listingIds) {
    const activeVersion = await deps.getActiveVersion(listingId);
    if (!activeVersion) {
      manifest.push({
        listingId,
        versionId: null,
        outcome: "listing_not_found",
      });
      continue;
    }

    const eligibility = await checkBulkUpdateEligibility(
      {
        workspaceId: input.workspaceId,
        listingId,
        versionId: activeVersion.id,
        freshnessAttested: input.freshnessAttested,
      },
      deps,
    );
    if (!eligibility.ok) {
      manifest.push(
        exclusionFor(listingId, activeVersion.id, eligibility.reason),
      );
      continue;
    }
    const { link } = eligibility;

    // Eligible rows in one workbook must target one store. Different import
    // batches from that same store are allowed.
    if (sharedConnectionId === null) {
      sharedConnectionId = link.connectionId;
    } else if (link.connectionId !== sharedConnectionId) {
      throw new ShoplineBulkFormError([
        {
          code: "mixed_source_connections",
          productId: null,
          column: null,
          message:
            "requested listings resolve to more than one SHOPLINE connection; export one store at a time",
        },
      ]);
    }

    if (!link.rawRow || !isBulkFormRawRow(link.rawRow)) {
      manifest.push({
        listingId,
        versionId: activeVersion.id,
        outcome: "raw_row_invalid",
      });
      continue;
    }

    evidence.push(eligibility.evidence);
    const { content } = activeVersion;
    rows.push({
      productId: link.remoteProductId,
      raw: link.rawRow,
      rowNumber: rows.length + 1,
    });
    enrichments.push({
      productId: link.remoteProductId,
      values: {
        nameZh: content.title["zh-Hant"],
        summaryEn: content.description.en,
        summaryZh: content.description["zh-Hant"],
        seoTitleEn: content.seo.title.en,
        seoTitleZh: content.seo.title["zh-Hant"],
        seoDescriptionEn: content.seo.description.en,
        seoDescriptionZh: content.seo.description["zh-Hant"],
        // No delimiter convention exists elsewhere in the codebase for this
        // field — chosen as the plain, human-editable form an operator
        // reviewing the file by eye would expect. Matches deliverBulkForm.
        seoKeywords: content.tags.join(", "),
      },
    });
    survivorRemoteProductIds.set(listingId, link.remoteProductId);
    // Placeholder outcome, corrected below once we know which survivors
    // actually produced a changed cell versus a pure no-op.
    manifest.push({
      listingId,
      versionId: activeVersion.id,
      outcome: "excluded_no_op",
    });
  }

  let update: ReturnType<typeof createBulkFormUpdate> | null = null;
  if (rows.length > 0) {
    try {
      update = createBulkFormUpdate(rows, enrichments, { include: "changed" });
    } catch (error) {
      // ShoplineBulkFormError covers 8 distinct issue codes (see
      // bulk-form.ts's BulkFormEnrichmentIssueCode) — only
      // "enrichment_no_changes" actually means "nothing changed". The rest
      // (duplicate product id, a value too long, blank, or containing
      // control characters) mean something is genuinely wrong with the
      // batch, and swallowing them here would silently report every
      // survivor — including unrelated, genuinely-changed ones — as
      // excluded_no_op with rowCount 0. Only the all-no-op case is treated
      // as a non-error; anything else rethrows. Unlike deliverBulkForm
      // (which catches this and returns a typed validation_error result),
      // this function lets it propagate raw — the caller (the export route)
      // is responsible for catching ShoplineBulkFormError and mapping
      // error.issues to a real HTTP error response.
      if (
        error instanceof ShoplineBulkFormError &&
        error.issues.every((issue) => issue.code === "enrichment_no_changes")
      ) {
        // Every survivor was a no-op after all (createBulkFormUpdate's own
        // "zero net changes" guard fires when nothing in the whole batch
        // changed) — every survivor's manifest entry stays excluded_no_op,
        // and we return no artifact bytes rather than propagating this as a
        // request error.
        update = null;
      } else {
        throw error;
      }
    }
  }

  // A survivor can appear more than once in `changes` (once per changed
  // column), so dedupe by productId to get "was this listing touched at
  // all" rather than "how many cells changed".
  const changedProductIds = new Set(
    (update?.changes ?? []).map((change) => change.productId),
  );
  for (const entry of manifest) {
    const remoteProductId = survivorRemoteProductIds.get(entry.listingId);
    if (
      remoteProductId !== undefined &&
      changedProductIds.has(remoteProductId)
    ) {
      entry.outcome = "included";
    }
  }

  // Re-read after all candidate reads, before constructing artifact bytes.
  // Callers recheck this captured evidence again at their mutation boundary.
  const includedEvidence = evidence.filter((item) =>
    changedProductIds.has(item.remoteProductId),
  );
  await recheckBulkExport(input, includedEvidence, deps);

  const specVersion = update?.specVersion ?? SHOPLINE_BULK_FORM_SPEC_VERSION;
  const body = update ? writeBulkFormWorkbook(update.sheet) : new Uint8Array(0);

  // Self-check: re-parse exactly what was just written and confirm it
  // matches what was intended. An all-no-op batch has `update === null`
  // and `body` is an empty placeholder -- nothing to reparse.
  if (update && !sheetsMatch(readBulkFormSheet(body), update.sheet)) {
    throw new Error(
      "generated bulk-form workbook failed its own reparse-and-assert check -- the written bytes do not match the intended sheet",
    );
  }

  const rowCount = manifest.filter(
    (entry) => entry.outcome === "included",
  ).length;

  return { manifest, evidence: includedEvidence, rowCount, specVersion, body };
}

export function exclusionFor(
  listingId: string,
  versionId: string,
  reason: BulkUpdateEligibilityReason,
): ExportManifestEntry {
  const outcome =
    reason === "approval_required"
      ? "excluded_unapproved"
      : reason === "blocking_flags"
        ? "excluded_blocked"
        : reason === "confirmation_required" ||
            reason === "confirmation_changed"
          ? "excluded_unconfirmed"
          : reason === "not_import_origin"
            ? "not_import_origin"
            : "excluded_stale";
  return { listingId, versionId, outcome, reason };
}

export class BulkUpdateEligibilityConflict extends Error {
  constructor(readonly entry: ExportManifestEntry) {
    super("Bulk Update review evidence changed; reload before exporting.");
  }
}

export async function recheckBulkExport(
  input: Pick<CreateBulkExportInput, "workspaceId" | "freshnessAttested">,
  evidence: readonly BulkUpdateEvidence[],
  deps: BulkUpdateEligibilityDeps,
): Promise<void> {
  for (const expected of evidence) {
    const result = await checkBulkUpdateEligibility(
      {
        ...input,
        listingId: expected.listingId,
        versionId: expected.versionId,
      },
      deps,
      expected,
    );
    if (!result.ok)
      throw new BulkUpdateEligibilityConflict(
        exclusionFor(expected.listingId, expected.versionId, result.reason),
      );
  }
}

/** Bind every authorization read to the caller's workspace transaction. */
export function createBulkExportDeps(repositories: {
  listings: Pick<ListingRepository, "getReviewSnapshot">;
  platformProducts: Pick<PlatformProductRepository, "getByListingId">;
  reviewConfirmations: Pick<ReviewConfirmationRepository, "getByVersionId">;
  sourceImports: Pick<SourceImportRepository, "getById">;
}): CreateBulkExportDeps {
  return {
    async getActiveVersion(listingId) {
      const snapshot = await repositories.listings.getReviewSnapshot(listingId);
      return snapshot?.activeVersion ?? null;
    },
    async getReviewState(listingId) {
      const snapshot = await repositories.listings.getReviewSnapshot(listingId);
      if (!snapshot) return null;
      return {
        status: snapshot.listing.status,
        // getReviewSnapshot can span multiple listing reads at READ COMMITTED.
        // Never pair an older approved status with a different active version.
        activeVersionId:
          snapshot.listing.activeVersionId === snapshot.activeVersion?.id
            ? snapshot.activeVersion.id
            : null,
        flags: snapshot.flags,
      };
    },
    getReviewConfirmation: (versionId) =>
      repositories.reviewConfirmations.getByVersionId(versionId),
    getPlatformProductLink: (listingId) =>
      repositories.platformProducts.getByListingId(listingId),
    async getSourceImportHeaderContractSha256(sourceImportId) {
      return (
        (await repositories.sourceImports.getById(sourceImportId))
          ?.headerContractSha256 ?? null
      );
    },
    currentHeaderContractSha256: () => hashBulkFormHeaderContract(),
  };
}
