import type { Database } from "@wukong/db";
import {
  hashBulkFormRow,
  parseBulkForm,
  type BulkFormIssue,
  type BulkFormSheet,
} from "@wukong/shopline";

import { ApiError } from "./route-support";

export type BulkFormImportDeps = { getDatabase(): Database };

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

        for (const row of parsed.rows) {
          const prior = knownByRemoteId.get(row.productId);
          // `rawRow` and `contentDigest` are derived from this one object in this
          // one statement, so the pair the repository stores cannot disagree.
          const rawRow = { ...row.raw };
          const contentDigest = hashBulkFormRow(rawRow);
          let listingId = prior?.listingId ?? null;

          if (listingId === null) {
            const draft = await repositories.listings.create({
              target: "shopline",
              note: `Imported from SHOPLINE bulk update form ${parsed.specVersion}, row ${row.rowNumber}`,
            });
            listingId = draft.id;
            createdDrafts += 1;
            // Metadata carries identifiers only — never merchant content.
            await repositories.audit.write({
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              entityId: draft.id,
              action: "listing.imported",
              metadata: {
                remoteProductId: row.productId,
                specVersion: parsed.specVersion,
                sourceRow: row.rowNumber,
              },
            });
          } else if (
            prior !== undefined &&
            prior.contentDigest !== contentDigest
          ) {
            refreshedProducts += 1;
          }

          await repositories.platformProducts.upsert({
            connectionId: connection.id,
            remoteProductId: row.productId,
            sku: row.sku,
            listingId,
            specVersion: parsed.specVersion,
            rawRow,
            factsPrefill: row.facts,
            contentDigest,
          });
        }

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
