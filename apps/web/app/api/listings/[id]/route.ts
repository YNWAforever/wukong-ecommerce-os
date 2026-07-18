import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
type ListingRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  connectionStatus?: (
    workspaceId: string,
  ) => Promise<"connected" | "disconnected" | "error">;
};

const roleRank: Record<string, number> = {
  viewer: 10,
  operator: 20,
  reviewer: 30,
  admin: 40,
  owner: 50,
};

function listingPermissions(role: string) {
  const rank = roleRank[role] ?? 0;
  return {
    canEdit: rank >= 20,
    canResolveFlags: rank >= 20,
    canApprove: rank >= 30,
    canDeliver: rank >= 30,
  };
}
export function createListingViewHandler(deps: ListingRouteDeps) {
  return async function listingViewHandler(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id))
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const result = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const snapshot = await repositories.listings.getReviewSnapshot(id);
          if (!snapshot)
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          const versionId = snapshot.activeVersion?.id ?? null;
          const job = versionId
            ? await repositories.publishJobs.getByIdempotencyKey(
                `${session.workspaceId}:${versionId}:shopline:create`,
              )
            : null;
          let connection: "connected" | "disconnected" | "error";
          try {
            if (deps.connectionStatus) {
              connection = await deps.connectionStatus(session.workspaceId);
            } else {
              const configured =
                await repositories.shoplineConnections.getDefault();
              connection = configured ? "connected" : "disconnected";
            }
          } catch {
            connection = "error";
          }

          return {
            listingId: id,
            workspaceId: session.workspaceId,
            status: snapshot.listing.status,
            activeVersion: snapshot.activeVersion,
            evidence: snapshot.evidence,
            flags: snapshot.flags,
            connection,
            delivery: job
              ? {
                  status: job.status,
                  remoteProductId:
                    job.status === "published" ? job.remoteProductId : null,
                  error: job.status === "failed" ? job.error : null,
                }
              : null,
            queueStatus: job?.status ?? null,
            permissions: listingPermissions(session.role),
          };
        });
      return jsonResponse(200, result);
    });
  };
}

export const GET = createListingViewHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
