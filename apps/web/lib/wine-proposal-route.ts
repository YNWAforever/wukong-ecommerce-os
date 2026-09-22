import { z } from "zod";
import {
  adoptWineProposal,
  readWineProposalDiff,
  type Database,
} from "@wukong/db";
import type { SessionContextPort } from "./session-context-port";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "./route-support";
const uuid = z.uuid().transform((v) => v.toLowerCase());
const bodySchema = z
  .object({
    expectedInputRevision: z.number().int().positive(),
    baseVersionId: uuid,
    selectedPaths: z.array(z.string()).min(1).max(100),
  })
  .strict()
  .refine((v) => new Set(v.selectedPaths).size === v.selectedPaths.length);
function mapped(error: unknown): never {
  const code = error instanceof Error ? error.message : "";
  if (code === "proposal_not_found")
    throw new ApiError(404, code, "Proposal not found.");
  if (["proposal_selection_invalid", "proposal_path_protected"].includes(code))
    throw new ApiError(
      422,
      code,
      "Select only available fields or complete bilingual sections.",
    );
  if (
    [
      "proposal_current_changed",
      "proposal_status_changed",
      "proposal_binding_invalid",
      "idempotency_conflict",
      "proposal_identity_retained_content",
      "proposal_support_incompatible",
      "proposal_claim_origin_collision",
      "evidence_refresh_required",
    ].includes(code) ||
    /^adopted_[a-z_]+$/.test(code)
  )
    throw new ApiError(
      409,
      code,
      "Reload the current proposal and evidence before adoption.",
    );
  throw error;
}
export function createWineProposalHandlers(deps: {
  sessionContext: SessionContextPort;
  getDatabase: () => Pick<Database, "forWorkspace">;
  read?: typeof readWineProposalDiff;
  adopt?: typeof adoptWineProposal;
}) {
  const handler =
    (adoption: boolean) =>
    async (
      request: Request,
      context: { params: Promise<{ id: string; runId: string }> },
    ) => {
      const response = await withRouteErrors(async () => {
        const session = await requireSessionContext(deps.sessionContext);
        if (!["operator", "reviewer", "admin", "owner"].includes(session.role))
          throw new ApiError(
            403,
            "insufficient_role",
            "Operator access is required.",
          );
        const raw = await context.params;
        if (
          !uuid.safeParse(raw.id).success ||
          !uuid.safeParse(raw.runId).success
        )
          throw new ApiError(404, "proposal_not_found", "Proposal not found.");
        const scope = {
          workspaceId: session.workspaceId,
          listingId: raw.id.toLowerCase(),
          runId: raw.runId.toLowerCase(),
        };
        const body = adoption ? bodySchema.parse(await request.json()) : null;
        const operationKey = adoption
          ? uuid.parse(request.headers.get("Idempotency-Key"))
          : null;
        try {
          const result = await deps
            .getDatabase()
            .forWorkspace(session.workspaceId, async (r) => {
              if (!body) return (deps.read ?? readWineProposalDiff)(r, scope);
              const adopted = await (deps.adopt ?? adoptWineProposal)(r, {
                ...scope,
                ...body,
                actorId: session.actorId,
                operationKey: operationKey!,
              });
              const current = await r.listings.getById(scope.listingId);
              return {
                ...adopted,
                current: current
                  ? {
                      inputRevision: current.inputRevision,
                      activeVersionId: current.activeVersionId,
                    }
                  : null,
              };
            });
          return jsonResponse(200, result);
        } catch (error) {
          mapped(error);
        }
      });
      response.headers.set("Cache-Control", "no-store");
      return response;
    };
  return { GET: handler(false), POST: handler(true) };
}
