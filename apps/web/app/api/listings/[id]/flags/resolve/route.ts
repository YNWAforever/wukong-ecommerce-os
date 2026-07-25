import {
  resolveFlag as domainResolveFlag,
  type AuditContext,
  type ComplianceFlag,
} from "@wukong/core";
import { z } from "zod";

import { getDatabase } from "../../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
type ResolveComplianceFlagRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  resolveFlag?: typeof domainResolveFlag;
};

const bodySchema = z
  .object({
    versionId: z.string().uuid(),
    flagId: z.string().trim().min(1),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

function assertOperator(role: string): void {
  if (!["operator", "reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Operator access is required.",
    );
  }
}

export function createResolveComplianceFlagHandler(
  deps: ResolveComplianceFlagRouteDeps,
) {
  return async function resolveComplianceFlagHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertOperator(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      }
      const body = bodySchema.parse(await request.json());
      const auditContext: AuditContext = {
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        entityId: id,
      };

      const flag = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const snapshot = await repositories.listings.getReviewSnapshot(id);
          if (!snapshot) {
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          }
          if (
            !snapshot.activeVersion ||
            snapshot.activeVersion.id !== body.versionId
          ) {
            throw new ApiError(
              409,
              "stale_version",
              "Listing changed; reload before resolving a flag.",
            );
          }
          const current = (snapshot.flags as ComplianceFlag[]).find(
            (candidate) => candidate.id === body.flagId,
          );
          if (!current) {
            throw new ApiError(
              404,
              "flag_not_found",
              "Compliance flag not found.",
            );
          }
          if (current.status === "resolved") return current;

          const resolved = await (deps.resolveFlag ?? domainResolveFlag)(
            current,
            body.reason,
            auditContext,
            repositories.audit,
          );
          await repositories.listings.replaceFlags(
            body.versionId,
            (snapshot.flags as ComplianceFlag[]).map((candidate) =>
              candidate.id === resolved.id ? resolved : candidate,
            ),
          );
          return resolved;
        });

      return jsonResponse(200, {
        listingId: id,
        versionId: body.versionId,
        flag,
      });
    });
  };
}

export const POST = createResolveComplianceFlagHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
