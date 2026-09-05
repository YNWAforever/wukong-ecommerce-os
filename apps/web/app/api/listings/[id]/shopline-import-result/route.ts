import { z } from "zod";

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
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
};

const bodySchema = z
  .object({
    outcome: z.enum(["accepted", "rejected"]),
    rejectReason: z.string().min(1).max(2000).optional(),
    exportAttemptId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (body) => body.outcome !== "rejected" || body.rejectReason !== undefined,
    { message: 'rejectReason is required when outcome is "rejected".' },
  );

export function createImportResultHandler(deps: ImportResultRouteDeps) {
  return async function importResultHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", session.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      }

      const body = bodySchema.parse(await request.json());

      const created = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const listing = await repositories.listings.getById(id);
          if (!listing) {
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          }

          if (body.exportAttemptId) {
            const attempt = await repositories.exportAttempts.getById(
              body.exportAttemptId,
            );
            if (!attempt) {
              throw new ApiError(
                404,
                "export_attempt_not_found",
                "Export attempt not found.",
              );
            }
            const legacy =
              attempt.provenance == null &&
              attempt.artifactStatus == null &&
              attempt.artifactSha256 == null;
            if (!legacy && attempt.artifactStatus !== "ready") {
              throw new ApiError(
                409,
                "export_artifact_not_ready",
                "The export artifact is not ready.",
              );
            }
          }

          const row = await repositories.importResults.create({
            listingId: id,
            exportAttemptId: body.exportAttemptId ?? null,
            outcome: body.outcome,
            rejectReason: body.rejectReason ?? null,
            recordedBy: session.actorId,
          });

          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: id,
            action: "listing.shopline_import_result_recorded",
            metadata: {
              outcome: body.outcome,
              exportAttemptId: body.exportAttemptId ?? null,
            },
          });

          return row;
        });

      return jsonResponse(201, {
        id: created.id,
        listingId: created.listingId,
        outcome: created.outcome,
        exportAttemptId: created.exportAttemptId,
        createdAt: created.createdAt.toISOString(),
      });
    });
  };
}

export const POST = createImportResultHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
