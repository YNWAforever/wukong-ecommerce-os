import { z } from "zod";
import { workingFields, type WorkingField } from "@wukong/core";
import type { Database } from "@wukong/db";
import { getDatabase } from "../../../../../../../lib/intake-runtime";
import { adoptListingCandidate } from "../../../../../../../lib/listing-candidate-service";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../../../lib/session-context-port";
const bodySchema = z
  .object({
    expectedInputRevision: z.number().int().positive(),
    baseVersionId: z.string().uuid().nullable(),
    selectedFieldPaths: z
      .array(z.enum(workingFields as [WorkingField, ...WorkingField[]]))
      .min(1)
      .max(workingFields.length),
  })
  .strict();
export function createAdoptListingCandidateHandler(deps: {
  sessionContext: SessionContextPort;
  getDatabase: () => Pick<Database, "forWorkspace">;
}) {
  return async (
    request: Request,
    context: { params: Promise<{ id: string; runId: string }> },
  ) =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!["operator", "reviewer", "admin", "owner"].includes(session.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      const { id, runId } = await context.params;
      if (
        !z.string().uuid().safeParse(id).success ||
        !z.string().uuid().safeParse(runId).success
      )
        throw new ApiError(404, "run_not_found", "Run not found.");
      const body = bodySchema.parse(await request.json());
      const operationKey = z
        .string()
        .uuid()
        .parse(request.headers.get("Idempotency-Key"));
      try {
        const saved = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, (repos) =>
            adoptListingCandidate(repos, {
              ...body,
              workspaceId: session.workspaceId,
              listingId: id,
              runId,
              actorId: session.actorId,
              operationKey,
            }),
          );
        return jsonResponse(200, {
          listingId: id,
          inputRevision: saved.revision,
          activeVersionId: saved.baseVersionId,
          processing: null,
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (error instanceof ApiError) throw error;
        if (
          code &&
          [
            "input_revision_conflict",
            "base_version_conflict",
            "listing_busy",
            "idempotency_conflict",
          ].includes(code)
        )
          throw new ApiError(
            409,
            code,
            "Inputs changed; reload before adopting.",
          );
        throw error;
      }
    });
}
export const POST = createAdoptListingCandidateHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
