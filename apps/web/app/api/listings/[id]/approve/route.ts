import { approveListing as domainApprove, type AuditContext } from "@wukong/core";
import { z } from "zod";

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
  getDatabase: () => { forWorkspace<T>(workspaceId: string, work: (repositories: any) => Promise<T>): Promise<T> };
  approve?: typeof domainApprove;
};

const bodySchema = z.object({}).strip();

function assertReviewer(role: string): void {
  if (!["reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(403, "insufficient_role", "Reviewer access is required.");
  }
}

export function createApproveListingHandler(deps: ApprovalRouteDeps) {
  return async function approveListingHandler(request: Request, context: RouteContext): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "listing_not_found", "Listing not found.");
      await bodySchema.parseAsync(await request.json().catch(() => ({})));
      const auditContext: AuditContext = { workspaceId: session.workspaceId, actorId: session.actorId, entityId: id };
      const result = await deps.getDatabase().forWorkspace(session.workspaceId, async (repositories) => {
        let listing: any;
        try {
          listing = await repositories.listings.requireForPublish(id);
        } catch (error) {
          if (error instanceof Error && /not found/i.test(error.message)) {
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          }
          throw error;
        }
        if (listing.target !== "shopline" || !listing.activeVersion) {
          throw new ApiError(409, "approval_required", "可批准的版本不存在。");
        }
        try {
          const approved = await (deps.approve ?? domainApprove)(listing.activeVersion.id, listing.flags, auditContext, repositories.audit);
          if (typeof repositories.listings.approve !== "function") throw new Error("listing approval repository is unavailable");
          await repositories.listings.approve(id, approved.versionId, auditContext, repositories.audit);
          return { listingId: id, versionId: approved.versionId, status: approved.status as "approved" };
        } catch (error) {
          if (error instanceof Error && /blocking compliance flags/i.test(error.message)) {
            throw new ApiError(422, "blocking_flags", "仍有未解決的合規標記，請先處理。");
          }
          throw error;
        }
      });
      return jsonResponse(200, result);
    });
  };
}

export const POST = createApproveListingHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

