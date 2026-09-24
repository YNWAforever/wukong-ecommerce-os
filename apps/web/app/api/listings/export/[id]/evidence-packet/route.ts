import { z } from "zod";
import { createExportEvidenceService } from "../../../../../../lib/export-evidence-service";
import {
  getDatabase,
  getAssetStore,
} from "../../../../../../lib/intake-runtime";
import {
  ApiError,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../../lib/session-context-port";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const bodySchema = z
  .object({
    comparisonId: z.uuid(),
    expectedSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function createExportEvidenceHandlers(deps: {
  sessionContext: SessionContextPort;
  service: ReturnType<typeof createExportEvidenceService>;
}) {
  async function auth(context: Context) {
    const session = await requireSessionContext(deps.sessionContext);
    if (!["reviewer", "admin", "owner"].includes(session.role))
      throw new ApiError(
        403,
        "insufficient_role",
        "Reviewer access is required.",
      );
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success)
      throw new ApiError(
        404,
        "export_attempt_not_found",
        "Export attempt not found.",
      );
    return { session, id };
  }
  async function protect(work: () => Promise<Response>) {
    const response = await withRouteErrors(async () => {
      try {
        return await work();
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(
          503,
          "evidence_packet_unavailable",
          "The evidence packet is unavailable. Retry later.",
        );
      }
    });
    response.headers.set("cache-control", "no-store");
    return response;
  }
  return {
    GET: (request: Request, context: Context) =>
      protect(async () => {
        const { session, id } = await auth(context);
        const comparisonId = new URL(request.url).searchParams.get(
          "comparisonId",
        );
        if (!z.uuid().safeParse(comparisonId).success)
          throw new ApiError(
            400,
            "invalid_request",
            "Choose a valid comparison.",
          );
        return Response.json(
          await deps.service.preview({
            workspaceId: session.workspaceId,
            exportAttemptId: id,
            comparisonId: comparisonId!,
          }),
        );
      }),
    POST: (request: Request, context: Context) =>
      protect(async () => {
        const { session, id } = await auth(context);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          throw new ApiError(
            400,
            "invalid_request",
            "Request body is invalid.",
          );
        }
        const parsed = bodySchema.safeParse(body);
        if (!parsed.success)
          throw new ApiError(
            400,
            "invalid_request",
            "Preview identity is required.",
          );
        const result = await deps.service.download({
          workspaceId: session.workspaceId,
          actorId: session.actorId,
          exportAttemptId: id,
          ...parsed.data,
        });
        return new Response(result.json, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${result.filename}"`,
            "x-content-type-options": "nosniff",
          },
        });
      }),
  };
}
const handlers = createExportEvidenceHandlers({
  sessionContext: authSessionContext,
  service: createExportEvidenceService({ getDatabase, getAssetStore }),
});
export const GET = handlers.GET;
export const POST = handlers.POST;
