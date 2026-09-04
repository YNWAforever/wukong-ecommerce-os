import { createHash } from "node:crypto";

import type { AssetStore } from "@wukong/assets";
import { BULK_FORM_XLSX_MIME_TYPE, createExportAssetKey } from "@wukong/assets";
import { ShoplineBulkFormError } from "@wukong/shopline";
import { z } from "zod";

import {
  createBulkExport,
  createBulkExportDeps,
  recheckBulkExport,
  BulkUpdateEligibilityConflict,
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

// Membership outcomes belong in this request identity: revoking one selected
// row must not collide with an earlier attempt that included it. Durable source
// and artifact identity remains continuation Task 3.
function computeIdempotencyKey(
  workspaceId: string,
  freshnessAttested: boolean,
  manifest: readonly ExportManifestEntry[],
): string {
  const pairs = manifest
    .map((entry) =>
      JSON.stringify([
        entry.listingId,
        entry.versionId,
        entry.outcome,
        entry.reason ?? null,
      ]),
    )
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
        const database = deps.getDatabase();
        const input = {
          workspaceId: session.workspaceId,
          requestedBy: session.actorId,
          listingIds: body.listingIds,
          freshnessAttested: body.freshnessAttested,
        };
        const exported = await database.forWorkspace(
          session.workspaceId,
          (repositories) =>
            createBulkExport(input, createBulkExportDeps(repositories)),
        );
        if (exported.rowCount === 0) {
          return jsonResponse(200, {
            exportAttemptId: null,
            manifest: exported.manifest,
            rowCount: 0,
          });
        }

        // Revalidate the captured evidence in a fresh workspace transaction at
        // the attempt/artifact boundary. Nothing is persisted or audited if it
        // changed. Commit the attempt and audit before uploading, so rollback
        // cannot leave an orphan object. Artifact readiness is a separate concern.
        const attempt = await database.forWorkspace(
          session.workspaceId,
          async (repositories) => {
            await recheckBulkExport(
              input,
              exported.evidence,
              createBulkExportDeps(repositories),
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

            return ensured;
          },
        );

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
          exported.body,
          BULK_FORM_XLSX_MIME_TYPE,
        );

        return jsonResponse(200, {
          exportAttemptId: attempt.id,
          manifest: attempt.manifest,
          rowCount: attempt.rowCount,
        });
      } catch (error) {
        if (error instanceof BulkUpdateEligibilityConflict) {
          return jsonResponse(409, {
            code: "export_eligibility_changed",
            message: error.message,
            manifest: [error.entry],
            rowCount: 0,
          });
        }
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
