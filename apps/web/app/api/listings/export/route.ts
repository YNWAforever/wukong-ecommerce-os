import { exportGenerationSchema } from "../../../../lib/bulk-export-contract";
import { ImportResultConflict } from "@wukong/db";
import type { ExportAttempt } from "@wukong/db";
import { createHash } from "node:crypto";

import type { AssetStore } from "@wukong/assets";
import {
  artifactHash,
  ensureExportArtifact,
  ExportArtifactConflict,
} from "../../../../lib/export-artifact";
import { ShoplineBulkFormError } from "@wukong/shopline";

import {
  createBulkExport,
  createBulkExportDeps,
  recheckBulkExport,
  BulkUpdateEligibilityConflict,
  BulkExportPreviewConflict,
  requireBulkExportPreview,
  assertBulkRepairTargets,
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

const bodySchema = exportGenerationSchema;

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

/** Canonical JSON makes object property insertion order irrelevant to request identity. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export type ExportListingsRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  getAssetStore: () => Pick<AssetStore, "readObject" | "writeObjectIfAbsent">;
};

export function createExportListingsHandler(deps: ExportListingsRouteDeps) {
  return async function exportListingsHandler(
    request: Request,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const body = bodySchema.parse(await request.json());

      // Set equality, not containment: an attestation that omits a requested
      // listing never covered it, and one that names an extra listing was made
      // against a different selection. Either way the evidence does not
      // describe this export, so it is a bad request rather than a per-listing
      // outcome.
      const attested = new Map(
        body.attestation.listings.map((entry) => [
          entry.listingId,
          entry.contentDigest,
        ]),
      );
      if (
        attested.size !== body.listingIds.length ||
        body.listingIds.some((listingId) => !attested.has(listingId))
      ) {
        throw new ApiError(
          400,
          "attestation_incomplete",
          "The attestation does not cover exactly the listings requested.",
        );
      }

      try {
        const database = deps.getDatabase();
        const input = {
          workspaceId: session.workspaceId,
          requestedBy: session.actorId,
          listingIds: body.listingIds,
          fields: body.fields,
          ...(body.repair ? { repair: body.repair } : {}),
          attestedDigests: attested,
        };
        const exported = await database.forWorkspace(
          session.workspaceId,
          async (repositories) => {
            if (body.repair)
              await repositories.importResults.assertRejectedForRepair(
                body.repair,
              );
            const current = await createBulkExport(
              input,
              createBulkExportDeps(repositories),
            );
            if (body.repair)
              assertBulkRepairTargets(
                body.repair,
                current,
                await repositories.exportAttempts.getById(
                  body.repair.exportAttemptId,
                ),
              );
            return current;
          },
        );
        requireBulkExportPreview(body.previewSha256, input, exported);
        if (exported.rowCount === 0) {
          return jsonResponse(200, {
            exportAttemptId: null,
            manifest: exported.manifest,
            rowCount: 0,
          });
        }

        const artifactSha256 = artifactHash(exported.body);
        // Excluded-for-mismatch, not attested-count: the set-equality guard
        // above already forces attested.size to equal manifest.length on
        // every request that reaches here, so that count is invariant and
        // tells a reviewer nothing. This one varies with which digests
        // actually failed to match on this attempt.
        //
        // Named for the reason it counts, not for a cause it cannot prove:
        // also returns row_digest_mismatch when a review CONFIRMATION has gone
        // stale against current source content, which is a different fault from
        // the operator attesting the wrong digest. The manifest records only the
        // reason, not which of the three comparisons fired, so this counts any
        // digest disagreement. A reader of the raw audit row has only the field
        // name to go on, so it must not claim the operator was at fault.
        const rowDigestMismatchCount = exported.manifest.filter(
          (entry) => entry.reason === "row_digest_mismatch",
        ).length;
        const provenance = {
          fields: exported.fields,
          previewSha256: body.previewSha256,
          ...(body.repair ? { repairOf: body.repair } : {}),
          identityVersion: 1,
          workspaceId: session.workspaceId,
          rowDigestMismatchCount,
          headerContractSha256: exported.headerContractSha256,
          specVersion: exported.specVersion,
          rowOrder: exported.evidence.map((entry) => entry.listingId),
          evidence: exported.evidence,
          manifest: exported.manifest,
        };
        const idempotencyKey = createHash("sha256")
          .update(canonicalJson({ provenance, artifactSha256 }))
          .digest("hex");

        // Revalidate the captured evidence in a fresh workspace transaction at
        // the attempt/artifact boundary. Nothing is persisted or audited if it
        // changed. Commit the attempt and audit before uploading, so rollback
        // cannot leave an orphan object. Artifact readiness is a separate concern.
        const attempt = await database.forWorkspace(
          session.workspaceId,
          async (repositories) => {
            // Lock excluded candidates too before rechecking included evidence:
            // locking an included subset first can invert two requests' order.
            for (const id of [...body.listingIds].sort())
              await repositories.listings.lockReviewState(id);
            if (body.repair)
              await repositories.importResults.assertRejectedForRepair(
                body.repair,
              );
            await recheckBulkExport(
              input,
              exported.evidence,
              createBulkExportDeps(repositories),
            );
            const current = await createBulkExport(
              input,
              createBulkExportDeps(repositories),
            );
            if (body.repair)
              assertBulkRepairTargets(
                body.repair,
                current,
                await repositories.exportAttempts.getById(
                  body.repair.exportAttemptId,
                ),
              );
            requireBulkExportPreview(body.previewSha256, input, current);

            const ensured = await repositories.exportAttempts.ensure({
              idempotencyKey,
              requestedBy: session.actorId,
              manifest: exported.manifest,
              rowCount: exported.rowCount,
              specVersion: exported.specVersion,
              provenance,
              artifactSha256,
              sourceAttestation: body.attestation.listings,
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
                  rowDigestMismatchCount,
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

        let verified = false;
        let ready: ExportAttempt;
        try {
          await ensureExportArtifact(
            {
              workspaceId: session.workspaceId,
              id: attempt.id,
              artifactSha256: attempt.artifactSha256,
              body: exported.body,
            },
            deps.getAssetStore(),
          );
          verified = true;
          ready = await database.forWorkspace<ExportAttempt>(
            session.workspaceId,
            (repositories) =>
              repositories.exportAttempts.markReady({
                id: attempt.id,
                artifactSha256,
              }),
          );
        } catch (error) {
          const code =
            error instanceof ExportArtifactConflict
              ? error.code
              : verified
                ? "artifact_state_commit_failed"
                : "artifact_upload_failed";
          let artifactStatus = attempt.artifactStatus;
          try {
            const failed = await database.forWorkspace<ExportAttempt>(
              session.workspaceId,
              (repositories) =>
                repositories.exportAttempts.markFailed({
                  id: attempt.id,
                  artifactSha256,
                  errorCode: code,
                }),
            );
            artifactStatus = failed.artifactStatus;
          } catch {
            // The pending record remains retryable if the state database is unavailable.
            console.error(
              JSON.stringify({
                event: "export.artifact_state_unavailable",
                exportAttemptId: attempt.id,
              }),
            );
          }
          return jsonResponse(
            error instanceof ExportArtifactConflict ? 409 : 503,
            {
              code,
              message:
                error instanceof ExportArtifactConflict
                  ? error.message
                  : "The export file could not be confirmed ready; retry the export.",
              exportAttemptId: attempt.id,
              artifactStatus,
            },
          );
        }

        return jsonResponse(200, {
          exportAttemptId: attempt.id,
          manifest: attempt.manifest,
          rowCount: attempt.rowCount,
          artifactStatus: ready.artifactStatus,
          artifactSha256,
        });
      } catch (error) {
        if (
          error instanceof BulkExportPreviewConflict ||
          error instanceof ImportResultConflict
        ) {
          return jsonResponse(409, {
            code:
              error instanceof ImportResultConflict
                ? error.code
                : "export_preview_changed",
            message:
              "The reviewed export or rejected receipt changed. Preview again before exporting.",
          });
        }
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
