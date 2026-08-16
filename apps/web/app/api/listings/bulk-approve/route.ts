import type { approveListing as domainApprove } from "@wukong/core";
import { z } from "zod";

import { approveOne } from "../../../../lib/listing-approval";
import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

/**
 * 50 is a starting bound, not a load-bearing one — see the design spec's
 * open questions. Chosen to keep a worst-case sequential loop comfortably
 * sub-second; a client selecting more than this chunks into multiple
 * requests rather than the server accepting an unbounded list.
 */
const MAX_BULK_APPROVE_IDS = 50;

const bodySchema = z.object({
  listingIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_APPROVE_IDS),
});

function assertReviewer(role: string): void {
  if (!["reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Reviewer access is required.",
    );
  }
}

export type BulkApproveItemResult =
  | { listingId: string; ok: true; versionId: string }
  | { listingId: string; ok: false; code: string; message: string };

export type BulkApproveRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  approve?: typeof domainApprove;
};

export function createBulkApproveHandler(deps: BulkApproveRouteDeps) {
  return async function bulkApproveHandler(
    request: Request,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const body = bodySchema.parse(await request.json());

      // Sequential, one transaction per listing — not one transaction for the
      // whole batch. A stale flag on one listing must approve the rest, not
      // roll them back; see the design spec's "Chosen design" section.
      const results: BulkApproveItemResult[] = [];
      for (const id of body.listingIds) {
        const auditContext = {
          workspaceId: session.workspaceId,
          actorId: session.actorId,
          entityId: id,
        };
        try {
          const approved = await deps
            .getDatabase()
            .forWorkspace(session.workspaceId, (repositories) =>
              approveOne(id, auditContext, repositories, {
                approve: deps.approve,
              }),
            );
          results.push({
            listingId: id,
            ok: true,
            versionId: approved.versionId,
          });
        } catch (error) {
          if (error instanceof ApiError) {
            results.push({
              listingId: id,
              ok: false,
              code: error.code,
              message: error.message,
            });
          } else {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            results.push({
              listingId: id,
              ok: false,
              code: "unknown_error",
              message,
            });
          }
        }
      }

      const approved = results.filter((result) => result.ok).length;
      return jsonResponse(200, {
        results,
        approved,
        failed: results.length - approved,
      });
    });
  };
}

export const POST = createBulkApproveHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
