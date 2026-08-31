import type { CanonicalListing } from "@wukong/core";
import {
  assertExportFreshness,
  type AssertExportFreshnessDeps,
  type FreshnessFailureReason,
} from "@wukong/core";
import {
  createBulkFormUpdate,
  isBulkFormRawRow,
  ShoplineBulkFormError,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
  type BulkFormEnrichment,
  type BulkFormExportRow,
} from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";

/**
 * The pure decision of which requested listings go into one multi-product
 * bulk-form export, and the row/enrichment each survivor contributes. No
 * database or HTTP here — every read comes through `deps`, mirroring how
 * `deliverBulkForm` in `delivery-service.ts` builds a single-listing export
 * row (same field mapping, same `isBulkFormRawRow` gate), scaled to many
 * listings behind one freshness-and-origin gate per listing.
 *
 * Known limitation (not fixable in this pure function): each survivor's
 * freshness check happens once, at that listing's own turn in the loop, but
 * `createBulkFormUpdate` runs once at the end for the whole batch. An early
 * survivor's platform-product row could change again while the rest of the
 * batch is still being read (each remaining listing does 2+ further awaited
 * reads), and nothing re-verifies it immediately before the final write.
 * Closing that gap needs a transaction or a final re-check at the caller's
 * I/O boundary — left for whoever wires the route/persistence layer around
 * this function.
 */
export type ExportManifestOutcome =
  | "included"
  | "excluded_no_op"
  | "excluded_stale"
  | "not_import_origin"
  | "raw_row_invalid"
  | "listing_not_found";

export type ExportManifestEntry = {
  listingId: string;
  versionId: string | null;
  outcome: ExportManifestOutcome;
  /** Present only when `outcome` is `excluded_stale`. */
  reason?: FreshnessFailureReason;
};

export type CreateBulkExportInput = {
  workspaceId: string;
  requestedBy: string;
  listingIds: readonly string[];
  freshnessAttested: boolean;
};

/**
 * A superset of `content-freshness.ts`'s `PlatformProductLink` — carries the
 * extra fields (`remoteProductId`, `rawRow`, `origin`) this orchestration
 * needs beyond what the freshness gate itself reads. Structurally assignable
 * wherever `PlatformProductLink` is expected.
 */
export type BulkExportPlatformProductLink = {
  remoteProductId: string;
  rawRow: Record<string, string | null> | null;
  origin: "import" | "created";
  sourceImportId: string | null;
  contentDigest: string | null;
};

/**
 * The only fields this orchestration reads from the active version's
 * content — same four (title/description/seo/tags) `deliverBulkForm` in
 * `delivery-service.ts` reads to build its single-listing export row. A
 * `Pick` rather than the full `CanonicalListing`, mirroring how
 * `BulkFormExportRow` in `@wukong/shopline`'s `bulk-form.ts` narrows to only
 * the fields `createBulkFormUpdate` actually touches.
 */
export type BulkExportListingContent = Pick<
  CanonicalListing,
  "title" | "description" | "seo" | "tags"
>;

export type CreateBulkExportDeps = {
  getPlatformProductLink(
    listingId: string,
  ): Promise<BulkExportPlatformProductLink | null>;
  getActiveVersion(
    listingId: string,
  ): Promise<{ id: string; content: BulkExportListingContent } | null>;
  getSourceImportHeaderContractSha256(
    sourceImportId: string,
  ): Promise<string | null>;
  currentHeaderContractSha256(): string;
};

export type CreateBulkExportResult = {
  manifest: ExportManifestEntry[];
  /** Count of listings actually written into the sheet — not raw cell-change count. */
  rowCount: number;
  specVersion: string;
  body: Uint8Array;
};

export async function createBulkExport(
  input: CreateBulkExportInput,
  deps: CreateBulkExportDeps,
): Promise<CreateBulkExportResult> {
  const manifest: ExportManifestEntry[] = [];
  const rows: BulkFormExportRow[] = [];
  const enrichments: BulkFormEnrichment[] = [];
  // listingId -> remoteProductId, for the listings that made it into `rows`.
  const survivorRemoteProductIds = new Map<string, string>();

  // Forwards straight to `deps` so `assertExportFreshness`'s own re-read of
  // the platform-product link and active version is a second, independent
  // call from the one this function makes below — not a memoized echo of it.
  // That is what lets it actually detect "the row moved between when we
  // looked and when we verified" instead of comparing a value to itself.
  const freshnessDeps: AssertExportFreshnessDeps = {
    getPlatformProductLink: (listingId) =>
      deps.getPlatformProductLink(listingId),
    getActiveVersionId: async (listingId) =>
      (await deps.getActiveVersion(listingId))?.id ?? null,
    getSourceImportHeaderContractSha256: (sourceImportId) =>
      deps.getSourceImportHeaderContractSha256(sourceImportId),
    currentHeaderContractSha256: () => deps.currentHeaderContractSha256(),
  };

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

    const link = await deps.getPlatformProductLink(listingId);
    if (!link || link.origin !== "import") {
      manifest.push({
        listingId,
        versionId: activeVersion.id,
        outcome: "not_import_origin",
      });
      continue;
    }

    const freshness = await assertExportFreshness(
      {
        workspaceId: input.workspaceId,
        listingId,
        expectedSourceImportId: link.sourceImportId ?? "",
        expectedRowDigest: link.contentDigest ?? "",
        expectedVersionId: activeVersion.id,
        freshnessAttested: input.freshnessAttested,
      },
      freshnessDeps,
    );
    if (!freshness.ok) {
      manifest.push({
        listingId,
        versionId: activeVersion.id,
        outcome: "excluded_stale",
        reason: freshness.reason,
      });
      continue;
    }

    if (!link.rawRow || !isBulkFormRawRow(link.rawRow)) {
      manifest.push({
        listingId,
        versionId: activeVersion.id,
        outcome: "raw_row_invalid",
      });
      continue;
    }

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
        // and we return an empty workbook rather than propagating this as a
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

  const specVersion = update?.specVersion ?? SHOPLINE_BULK_FORM_SPEC_VERSION;
  const body = update ? writeBulkFormWorkbook(update.sheet) : new Uint8Array(0);
  const rowCount = manifest.filter(
    (entry) => entry.outcome === "included",
  ).length;

  return { manifest, rowCount, specVersion, body };
}
