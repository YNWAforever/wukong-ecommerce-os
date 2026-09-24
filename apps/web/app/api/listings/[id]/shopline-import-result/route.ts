import { z } from "zod";
import { ImportResultConflict, type Database } from "@wukong/db";
import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";
type RouteContext = { params: Promise<{ id: string }> };
type ImportResultRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
};
const bodySchema = z
  .object({
    mode: z.enum(["export", "historical_manual"]),
    outcome: z.enum(["accepted", "rejected"]),
    rejectReason: z.string().trim().min(1).max(2000).optional(),
    exportAttemptId: z.string().uuid().optional(),
    versionId: z.string().uuid().optional(),
    idempotencyKey: z.string().trim().min(1).max(200),
    supersedesResultId: z.string().uuid().optional(),
    correctionReason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.outcome === "rejected"
        ? !!b.rejectReason
        : b.rejectReason === undefined,
    {
      message:
        "Rejected outcomes require a reason; accepted outcomes must omit it.",
    },
  )
  .refine(
    (b) =>
      b.mode === "export"
        ? !!b.exportAttemptId && !!b.versionId
        : b.exportAttemptId === undefined && b.versionId === undefined,
    {
      message:
        "Export reports require attempt and version; historical manual reports must be unlinked.",
    },
  )
  .refine((b) => !!b.supersedesResultId === !!b.correctionReason, {
    message: "Corrections require the observed receipt and a reason.",
  });
export function createImportResultHandler(deps: ImportResultRouteDeps) {
  return async function handler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", session.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      const { id } = await context.params;
      if (!z.uuid().safeParse(id).success)
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const body = bodySchema.parse(await request.json());
      try {
        const result = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repositories) => {
            const row = await repositories.importResults.create({
              mode: body.mode,
              listingId: id.toLowerCase(),
              exportAttemptId: body.exportAttemptId?.toLowerCase() ?? null,
              versionId: body.versionId?.toLowerCase() ?? null,
              idempotencyKey: body.idempotencyKey,
              outcome: body.outcome,
              rejectReason: body.rejectReason ?? null,
              recordedBy: session.actorId,
              supersedesResultId:
                body.supersedesResultId?.toLowerCase() ?? null,
              correctionReason: body.correctionReason ?? null,
            });
            if (row.wasCreated)
              await repositories.audit.write({
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: id,
                action: "listing.shopline_import_result_recorded",
                metadata: {
                  resultId: row.id,
                  mode: row.mode,
                  outcome: row.outcome,
                  exportAttemptId: row.exportAttemptId,
                  versionId: row.versionId,
                  supersedesResultId: row.supersedesResultId,
                  revision: row.revision,
                },
              });
            return row;
          });
        const { wasCreated, ...receipt } = result;
        return jsonResponse(wasCreated ? 201 : 200, {
          result: receipt,
          replayed: !wasCreated,
        });
      } catch (error) {
        if (error instanceof ImportResultConflict)
          throw new ApiError(
            error.status,
            error.code,
            error.status === 404
              ? "Listing or export attempt not found."
              : "The result could not be recorded. Refresh the export details and review the reporting context.",
          );
        throw error;
      }
    });
  };
}
export const POST = createImportResultHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
