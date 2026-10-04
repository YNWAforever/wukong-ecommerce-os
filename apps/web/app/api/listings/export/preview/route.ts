import { ImportResultConflict } from "@wukong/db";
import { ShoplineBulkFormError } from "@wukong/shopline";
import { exportSelectionSchema } from "../../../../../lib/bulk-export-contract";
import {
  createBulkExport,
  createBulkExportDeps,
  bulkExportPreview,
  BulkExportPreviewConflict,
  assertBulkRepairTargets,
  BulkUpdateEligibilityConflict,
} from "../../../../../lib/bulk-export-service";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";
import { getDatabase } from "../../../../../lib/intake-runtime";
export const runtime = "nodejs";
export function createExportPreviewHandler(deps: {
  sessionContext: SessionContextPort;
  getDatabase(): {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
}) {
  return async (request: Request): Promise<Response> =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!["reviewer", "admin", "owner"].includes(session.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Reviewer access is required.",
        );
      const body = exportSelectionSchema.parse(await request.json());
      if (
        body.attestation.listings.length !== body.listingIds.length ||
        body.listingIds.some(
          (id) =>
            !body.attestation.listings.some(
              (listing) => listing.listingId === id,
            ),
        )
      )
        throw new ApiError(
          400,
          "attestation_incomplete",
          "Attest exactly the requested listings.",
        );
      const input = {
        workspaceId: session.workspaceId,
        requestedBy: session.actorId,
        listingIds: body.listingIds,
        fields: body.fields,
        attestedDigests: new Map(
          body.attestation.listings.map((listing) => [
            listing.listingId,
            listing.contentDigest,
          ]),
        ),
        ...(body.repair ? { repair: body.repair } : {}),
      };
      try {
        const preview = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repositories) => {
            if (body.repair)
              await repositories.importResults.assertRejectedForRepair(
                body.repair,
              );
            const exported = await createBulkExport(
              input,
              createBulkExportDeps(repositories),
            );
            if (body.repair)
              assertBulkRepairTargets(
                body.repair,
                exported,
                await repositories.exportAttempts.getById(
                  body.repair.exportAttemptId,
                ),
              );
            return bulkExportPreview(input, exported);
          });
        return jsonResponse(200, preview);
      } catch (error) {
        if (error instanceof ImportResultConflict)
          throw new ApiError(
            error.status,
            error.code,
            "The rejected receipt changed. Reload the attempt before repairing.",
          );
        if (error instanceof BulkExportPreviewConflict)
          throw new ApiError(
            409,
            "repair_identity_changed",
            "The repair target changed. Review its identity before retrying.",
          );
        if (error instanceof BulkUpdateEligibilityConflict)
          throw new ApiError(
            409,
            "export_eligibility_changed",
            "Review or source evidence changed. Preview again.",
          );
        if (error instanceof ShoplineBulkFormError)
          throw new ApiError(
            409,
            "export_validation_failed",
            "Selected export content is invalid. Repair it before previewing.",
          );
        throw error;
      }
    });
}
export const POST = createExportPreviewHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
