import { createHash } from "node:crypto";

import type { AssetStore } from "@wukong/assets";
import { BULK_FORM_XLSX_MIME_TYPE, createExportAssetKey } from "@wukong/assets";
import {
  hashBulkFormHeaderContract,
  ShoplineBulkFormError,
} from "@wukong/shopline";
import { z } from "zod";

import {
  createBulkExport,
  type CreateBulkExportDeps,
  type ExportManifestEntry,
} from "../../../../lib/bulk-export-service";
import { getAssetStore, getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    listingIds: z.array(z.string().min(1)).min(1),
    freshnessAttested: z.boolean(),
  })
  .strict()
  .refine(
    (value) => new Set(value.listingIds).size === value.listingIds.length,
    {
      message: "listingIds must not contain duplicate entries",
      path: ["listingIds"],
    },
  );

// Identical to the deliver route's bespoke check (apps/web/app/api/listings/[id]/deliver/route.ts) --
// not exported there, so this is a local copy of the exact same rule rather than a shared import.
function assertReviewer(role: string): void {
  if (!["reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Reviewer access is required.",
    );
  }
}

/**
 * `workspaceId + freshnessAttested + sorted "listingId:versionId" pairs`,
 * hashed. `freshnessAttested` MUST be folded into the key: two requests for
 * the same listings/versions but different attestation values mean genuinely
 * different things (one may exclude every listing as `not_attested`, the
 * other may not), and colliding them on the same idempotency key would hand
 * the second caller back the first caller's stale, wrong manifest. A
 * `versionId` of `null` (e.g. a `listing_not_found` entry) participates as
 * the literal string `"null"` so those entries still affect the key instead
 * of being silently dropped.
 */
function computeIdempotencyKey(
  workspaceId: string,
  freshnessAttested: boolean,
  manifest: readonly Pick<ExportManifestEntry, "listingId" | "versionId">[],
): string {
  const pairs = manifest
    .map((entry) => `${entry.listingId}:${entry.versionId ?? "null"}`)
    .sort()
    .join(",");
  return createHash("sha256")
    .update(`${workspaceId}:${freshnessAttested}:${pairs}`)
    .digest("hex");
}

export type ExportListingsRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  getAssetStore: () => Pick<AssetStore, "writeObject">;
};

export function createExportListingsHandler(deps: ExportListingsRouteDeps) {
  return async function exportListingsHandler(
    request: Request,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const body = bodySchema.parse(await request.json());

      try {
        // The callback only returns identifiers and DB-durable data
        // (`attempt`) plus the pure-function output (`body`) -- the actual
        // asset-store write happens AFTER this resolves, once the
        // transaction has committed. Doing it inside the callback would let
        // a later failure in the same callback (e.g. the audit insert
        // hitting a transient error) roll back the `ensure()`d row while the
        // already-written object survives, orphaned under a key nothing will
        // ever reference again (a retry recomputes the same idempotency key
        // but `ensure()` does a fresh INSERT with a new random id). Writing
        // only after commit makes the one remaining failure direction the
        // safe one: a committed attempt whose object isn't written yet,
        // which a retry with the same idempotency key self-heals, since
        // `createBulkExport` is pure over its deps and the same inputs
        // deterministically produce the same bytes.
        const { attempt, body: workbookBody } = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repositories) => {
            const exportDeps: CreateBulkExportDeps = {
              async getActiveVersion(listingId) {
                const snapshot =
                  await repositories.listings.getReviewSnapshot(listingId);
                if (!snapshot?.activeVersion) return null;
                return {
                  id: snapshot.activeVersion.id,
                  content: snapshot.activeVersion.content,
                };
              },
              getPlatformProductLink: (listingId) =>
                repositories.platformProducts.getByListingId(listingId),
              async getSourceImportHeaderContractSha256(sourceImportId) {
                const sourceImport =
                  await repositories.sourceImports.getById(sourceImportId);
                return sourceImport?.headerContractSha256 ?? null;
              },
              currentHeaderContractSha256: () => hashBulkFormHeaderContract(),
            };

            // May throw ShoplineBulkFormError for a genuine validation
            // problem in the requested set (e.g. two listing ids resolving
            // to the same SHOPLINE remoteProductId) -- caught below, not
            // here, so it can be mapped to a real HTTP error response
            // instead of aborting the transaction with an opaque 500.
            const exported = await createBulkExport(
              {
                workspaceId: session.workspaceId,
                requestedBy: session.actorId,
                listingIds: body.listingIds,
                freshnessAttested: body.freshnessAttested,
              },
              exportDeps,
            );

            const idempotencyKey = computeIdempotencyKey(
              session.workspaceId,
              body.freshnessAttested,
              exported.manifest,
            );

            const ensured = await repositories.exportAttempts.ensure({
              idempotencyKey,
              requestedBy: session.actorId,
              manifest: exported.manifest,
              rowCount: exported.rowCount,
              specVersion: exported.specVersion,
            });

            // Only a genuinely new attempt gets its own audit event --
            // `ensure()` returning an existing row (a pure repeat/
            // double-click) must not duplicate it. Mirrors how
            // `deliverListing`'s publish path only audits after
            // `publishJobs.ensure()` reports a freshly created job
            // (apps/web/lib/delivery-service.ts).
            if (ensured.wasCreated) {
              await repositories.audit.write({
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: ensured.id,
                action: "listing.bulk_export_created",
                metadata: {
                  exportAttemptId: ensured.id,
                  includedListingIds: ensured.manifest
                    .filter(
                      (entry: ExportManifestEntry) =>
                        entry.outcome === "included",
                    )
                    .map((entry: ExportManifestEntry) => entry.listingId),
                  excludedListingIds: ensured.manifest
                    .filter(
                      (entry: ExportManifestEntry) =>
                        entry.outcome !== "included",
                    )
                    .map((entry: ExportManifestEntry) => entry.listingId),
                },
              });

              // One event per listing this attempt excluded for staleness --
              // same action as the approve route's Phase-0 rejections
              // (apps/web/app/api/listings/[id]/approve/route.ts), just
              // batched here since one export attempt can flag many listings
              // at once. Gated on `wasCreated` for the same reason as the
              // write above: a repeat/idempotent request replays the same
              // manifest and must not duplicate the events that a genuinely
              // new attempt already wrote.
              for (const entry of ensured.manifest) {
                if (entry.outcome === "excluded_stale" && entry.reason) {
                  await repositories.audit.write({
                    workspaceId: session.workspaceId,
                    actorId: session.actorId,
                    entityId: entry.listingId,
                    action: "listing.review_conflict",
                    metadata: { reason: entry.reason },
                  });
                }
              }
            }

            return { attempt: ensured, body: exported.body };
          });

        // Always write the workbook, even on a repeat request that hit the
        // same idempotency key -- see the comment above on why this is an
        // intentional, self-healing idempotent overwrite rather than wasted
        // work.
        await deps.getAssetStore().writeObject(
          session.workspaceId,
          createExportAssetKey({
            workspaceId: session.workspaceId,
            exportAttemptId: attempt.id,
            fileName: `export-${attempt.id}.xlsx`,
          }),
          workbookBody,
          BULK_FORM_XLSX_MIME_TYPE,
        );

        return jsonResponse(200, {
          exportAttemptId: attempt.id,
          manifest: attempt.manifest,
          rowCount: attempt.rowCount,
        });
      } catch (error) {
        if (error instanceof ShoplineBulkFormError) {
          return jsonResponse(409, {
            code: "export_validation_failed",
            message: error.message,
            issues: error.issues,
          });
        }
        throw error;
      }
    });
  };
}

export const POST = createExportListingsHandler({
  sessionContext: authSessionContext,
  getDatabase,
  getAssetStore,
});
