import type { Database, UpsertPlatformProductInput } from "@wukong/db";
import {
  hashBulkFormRow,
  parseBulkForm,
  renderBulkFormSource,
  type BulkFormGapsInput,
  type BulkFormIssue,
  type BulkFormSheet,
} from "@wukong/shopline";

import { ApiError } from "./route-support";

export type BulkFormImportDeps = { getDatabase(): Database };

/**
 * Ten times the pilot catalog. High enough that no real merchant form is
 * refused, low enough that the single import transaction stays bounded.
 */
export const MAX_IMPORT_ROWS = 5_000;

export type BulkFormImportInput = {
  workspaceId: string;
  actorId: string;
  sheet: BulkFormSheet;
};

export type BulkFormImportResult = {
  specVersion: string;
  parsedRows: number;
  createdDrafts: number;
  refreshedProducts: number;
  issues: BulkFormIssue[];
};

/**
 * The note an imported draft carries. An imported draft has no assets, so the
 * note is the only thing the AI `extract` step can read. Provenance comes first
 * so the note stays readable to an operator, then the rendered row, which is
 * what `extract` reads when this draft is enriched.
 *
 * The form's spec version is deliberately absent. It contains a four-digit year
 * (`opak-2026-05`), and extraction reads the first year-shaped token in the note
 * as the product's vintage — so including it made every imported product a 2026
 * vintage. The version is already recorded durably on `platform_products` and in
 * the import audit event, so the note does not need to carry it.
 *
 * Both write paths — first import and refresh — go through here so the note has
 * one shape.
 */
function importedDraftNote(
  rowNumber: number,
  rawRow: BulkFormGapsInput,
): string {
  return [
    `Imported from a SHOPLINE bulk update form, row ${rowNumber}`,
    "",
    renderBulkFormSource(rawRow),
  ].join("\n");
}

/**
 * Turns a parsed bulk update form into drafts joined to their remote products.
 *
 * Deliberately does not enqueue the AI pipeline. The normal intake path enqueues
 * one job per draft, which for a 500-product catalog would be 500 uncapped AI
 * runs. Enrichment is a separate, budgeted batch.
 */
export function createBulkFormImporter(deps: BulkFormImportDeps) {
  return async function importBulkForm(
    input: BulkFormImportInput,
  ): Promise<BulkFormImportResult> {
    const parsed = parseBulkForm(input.sheet);
    if (parsed.rows.length === 0) {
      throw new ApiError(
        422,
        "bulk_form_unreadable",
        "No product rows could be read from this bulk update form.",
      );
    }
    // Each row costs three statements inside one transaction, so an unbounded
    // sheet holds a pooled connection open for as long as it takes and can
    // outlive the function timeout. Bound it before opening the transaction.
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      throw new ApiError(
        413,
        "bulk_form_too_many_rows",
        `This form holds ${parsed.rows.length} products; imports are limited to ${MAX_IMPORT_ROWS} at a time.`,
      );
    }

    return deps
      .getDatabase()
      .forWorkspace(input.workspaceId, async (repositories) => {
        const connection = await repositories.shoplineConnections.getDefault();
        if (!connection) {
          throw new ApiError(
            409,
            "shopline_connection_missing",
            "Connect a SHOPLINE store before importing a catalog.",
          );
        }

        const known =
          await repositories.platformProducts.listByRemoteProductIds(
            connection.id,
            parsed.rows.map((row) => row.productId),
          );
        const knownByRemoteId = new Map(
          known.map((product) => [product.remoteProductId, product]),
        );

        let createdDrafts = 0;
        let refreshedProducts = 0;
        const mirrors: UpsertPlatformProductInput[] = [];

        for (const row of parsed.rows) {
          const prior = knownByRemoteId.get(row.productId);
          // `rawRow` and `contentDigest` are derived from this one object in this
          // one statement, so the pair the repository stores cannot disagree.
          const rawRow = { ...row.raw };
          const contentDigest = hashBulkFormRow(rawRow);
          const existingListingId = prior?.listingId ?? null;
          const isNewDraft = existingListingId === null;
          const isRefresh =
            !isNewDraft &&
            prior !== undefined &&
            prior.contentDigest !== contentDigest;

          let listingId: string;
          if (existingListingId === null) {
            const draft = await repositories.listings.create({
              target: "shopline",
              note: importedDraftNote(row.rowNumber, rawRow),
            });
            listingId = draft.id;
            createdDrafts += 1;
          } else {
            listingId = existingListingId;
            if (isRefresh) {
              refreshedProducts += 1;
              // The note is what the extract step reads, so a changed row must
              // update it or enrichment runs on data the merchant replaced.
              await repositories.listings.updateNote(
                listingId,
                importedDraftNote(row.rowNumber, rawRow),
              );
            }
          }

          // Both branches are domain mutations, so both are audited. Refreshing
          // a snapshot rewrites the row and its digest — the record of what the
          // catalog looked like — and that must not happen unrecorded. An
          // unchanged re-import mutates nothing and so writes nothing.
          if (isNewDraft || isRefresh) {
            // Metadata carries identifiers only — never merchant content.
            await repositories.audit.write({
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              entityId: listingId,
              action: isNewDraft
                ? "listing.imported"
                : "listing.import_refreshed",
              metadata: {
                remoteProductId: row.productId,
                specVersion: parsed.specVersion,
                sourceRow: row.rowNumber,
                ...(isRefresh ? { priorDigest: prior?.contentDigest } : {}),
              },
            });
          }

          mirrors.push({
            connectionId: connection.id,
            remoteProductId: row.productId,
            sku: row.sku,
            listingId,
            specVersion: parsed.specVersion,
            rawRow,
            factsPrefill: row.facts,
            contentDigest,
            // Every row this importer writes came from a bulk update form, never
            // from the direct-create-publish path.
            origin: "import",
          });
        }

        // One statement for every mirror row rather than one per product.
        await repositories.platformProducts.upsertMany(mirrors);

        return {
          specVersion: parsed.specVersion,
          parsedRows: parsed.rows.length,
          createdDrafts,
          refreshedProducts,
          issues: [...parsed.issues],
        };
      });
  };
}
