import {
  batchControlSchema,
  createBatchControlService,
  type BatchControlInput,
} from "../../../../../lib/enrichment-batch-control-service";
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
export function createBatchControlHandler(deps: {
  sessionContext: SessionContextPort;
  control(input: BatchControlInput): Promise<Record<string, unknown>>;
}) {
  return async (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", session.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      const body = batchControlSchema.parse(await request.json());
      const { id } = await context.params;
      return jsonResponse(
        202,
        await deps.control({
          ...body,
          batchId: id,
          workspaceId: session.workspaceId,
          actorId: session.actorId,
        }),
      );
    });
}
export const POST = createBatchControlHandler({
  sessionContext: authSessionContext,
  control: createBatchControlService(getDatabase),
});
