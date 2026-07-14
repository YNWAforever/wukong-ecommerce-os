import { canonicalListingSchema, type AuditContext, type CanonicalListing } from "@wukong/core";
import { z } from "zod";

import { getDatabase } from "../../../../../lib/intake-runtime";
import { ApiError, jsonResponse, requireSessionContext, withRouteErrors } from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
type ReviewRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => { forWorkspace<T>(workspaceId: string, work: (repositories: any) => Promise<T>): Promise<T> };
};

const reviewBodySchema = z.object({
  baseVersionId: z.string().uuid(),
  listing: canonicalListingSchema.optional(),
  content: canonicalListingSchema.optional(),
}).strict().refine((value) => Boolean(value.listing ?? value.content), "listing content is required");

function assertOperator(role: string): void {
  if (!["operator", "reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(403, "insufficient_role", "Operator access is required.");
  }
}

function changedFields(before: CanonicalListing, after: CanonicalListing): string[] {
  return Object.keys(after).filter((key) => JSON.stringify(before[key as keyof CanonicalListing]) !== JSON.stringify(after[key as keyof CanonicalListing]));
}

export function createReviewListingHandler(deps: ReviewRouteDeps) {
  return async function reviewListingHandler(request: Request, context: RouteContext): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertOperator(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "listing_not_found", "Listing not found.");
      const body = reviewBodySchema.parse(await request.json());
      const content = body.listing ?? body.content;
      if (!content) throw new ApiError(400, "invalid_request", "Listing content is required.");
      const auditContext: AuditContext = { workspaceId: session.workspaceId, actorId: session.actorId, entityId: id };
      const result = await deps.getDatabase().forWorkspace(session.workspaceId, async (repositories) => {
        const snapshot = await repositories.listings.getReviewSnapshot(id);
        if (!snapshot) throw new ApiError(404, "listing_not_found", "Listing not found.");
        if (!snapshot.activeVersion || snapshot.activeVersion.id !== body.baseVersionId) {
          throw new ApiError(409, "stale_version", "Listing changed; reload before saving.");
        }
        try {
          const version = await repositories.listings.editReview(id, body.baseVersionId, content, changedFields(snapshot.activeVersion.content, content), auditContext, repositories.audit);
          return { listingId: id, versionId: version.id, sequence: version.sequence };
        } catch (error) {
          if (error instanceof Error && /stale review version|changed while editing/i.test(error.message)) {
            throw new ApiError(409, "stale_version", "Listing changed; reload before saving.");
          }
          throw error;
        }
      });
      return jsonResponse(200, result);
    });
  };
}

export const PUT = createReviewListingHandler({ sessionContext: authSessionContext, getDatabase });
export const PATCH = PUT;

