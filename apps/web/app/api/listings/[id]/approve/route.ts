import {
  approveListing as domainApprove,
  type AuditContext,
} from "@wukong/core";
import { z } from "zod";

import { approveOne } from "../../../../../lib/listing-approval";
import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
type ApprovalRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  approve?: typeof domainApprove;
};

const bodySchema = z.object({}).strip();

function assertReviewer(role: string): void {
  if (!["reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Reviewer access is required.",
    );
  }
}

export function createApproveListingHandler(deps: ApprovalRouteDeps) {
  return async function approveListingHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id))
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      await bodySchema.parseAsync(await request.json().catch(() => ({})));
      const auditContext: AuditContext = {
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        entityId: id,
      };
      const result = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          approveOne(id, auditContext, repositories, { approve: deps.approve }),
        );
      return jsonResponse(200, result);
    });
  };
}

export const POST = createApproveListingHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
