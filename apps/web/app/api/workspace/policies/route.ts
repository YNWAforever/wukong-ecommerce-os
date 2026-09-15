import { createHash } from "node:crypto";
import { z } from "zod";
import {
  paidListingReservation,
  workspacePolicySchema,
  workspaceProfileSchema,
  type WorkspaceProfile,
} from "@wukong/core";
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
type Deps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};
const bodySchema = z
  .object({
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    policy: workspacePolicySchema,
  })
  .strict();
function configuredAdmission(profile: WorkspaceProfile) {
  try {
    const policy = profile.listingAi;
    return (
      process.env.LISTING_PAID_OPERATIONS_ENABLED === "true" &&
      Boolean(
        policy &&
        policy.provider === (process.env.AI_PROVIDER ?? "openai") &&
        Number(policy.budgetCapUsd) > 0 &&
        Number(policy.runCeilingUsd) >= Number(paidListingReservation(policy)),
      )
    );
  } catch {
    return false;
  }
}
function policyView(profile: WorkspaceProfile) {
  return {
    policy: {
      name: profile.name,
      tone: profile.tone,
      claimPolicy: profile.claimPolicy,
      requiredFields: profile.requiredFields,
      sourcePreferences: profile.sourcePreferences ?? { allowedDomains: [] },
    },
    digest: createHash("sha256")
      .update(JSON.stringify(workspaceProfileSchema.parse(profile)))
      .digest("hex"),
  };
}
export function createPolicyHandlers(deps: Deps) {
  return {
    GET: async (_request: Request) =>
      withRouteErrors(async () => {
        const session = await requireSessionContext(deps.sessionContext);
        if (!requireWorkspaceRole("admin", session.role))
          throw new ApiError(
            403,
            "insufficient_role",
            "Admin access is required.",
          );
        const result = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repos) => {
            const profile = await repos.workspaces.requireProfile();
            return {
              ...policyView(profile),
              usage: await repos.workspaces.usageSummary(),
              admission: {
                enabled: configuredAdmission(profile),
                provider: profile.listingAi?.provider ?? null,
                model: profile.listingAi?.model ?? null,
                capUsd: profile.listingAi?.budgetCapUsd ?? null,
              },
            };
          });
        return jsonResponse(200, result);
      }),
    PATCH: async (request: Request) =>
      withRouteErrors(async () => {
        const session = await requireSessionContext(deps.sessionContext);
        if (!requireWorkspaceRole("admin", session.role))
          throw new ApiError(
            403,
            "insufficient_role",
            "Admin access is required.",
          );
        const parsed = bodySchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success)
          throw new ApiError(400, "invalid_body", "Invalid workspace policy.");
        try {
          const profile = await deps
            .getDatabase()
            .forWorkspace(session.workspaceId, async (repos) => {
              const next = await repos.workspaces.updateSettings(
                parsed.data.policy,
                parsed.data.expectedDigest,
              );
              await repos.audit.write({
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: session.workspaceId,
                action: "workspace.policy_updated",
                metadata: { fields: Object.keys(parsed.data.policy) },
              });
              return next;
            });
          return jsonResponse(200, policyView(profile));
        } catch (error) {
          if ((error as { code?: string }).code === "workspace_policy_conflict")
            throw new ApiError(
              409,
              "workspace_policy_conflict",
              "Settings changed. Reload and reapply your changes.",
            );
          throw error;
        }
      }),
  };
}
const handlers = createPolicyHandlers({
  sessionContext: authSessionContext,
  getDatabase,
});
export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
