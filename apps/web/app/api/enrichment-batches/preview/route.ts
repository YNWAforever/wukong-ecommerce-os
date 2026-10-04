import {
  previewRequestSchema,
  createBatchSelectionService,
  type BatchPreviewResult,
} from "../../../../lib/batch-selection";
import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";
import type { z } from "zod";

export function createBatchPreviewHandler(deps: {
  sessionContext: SessionContextPort;
  preview(
    input: z.infer<typeof previewRequestSchema> & {
      workspaceId: string;
      actorId: string;
    },
  ): Promise<BatchPreviewResult>;
}) {
  return (request: Request) =>
    withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      const body = previewRequestSchema.parse(await request.json());
      const result = await deps.preview({
        ...body,
        workspaceId: context.workspaceId,
        actorId: context.actorId,
      });
      return jsonResponse(200, result);
    });
}
const service = createBatchSelectionService({ getDatabase });
export const POST = createBatchPreviewHandler({
  sessionContext: authSessionContext,
  preview: (input) =>
    "selection" in input
      ? service.preview(input)
      : service.previewCohort(input),
});
