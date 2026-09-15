import { readCopyClaimSupports } from "./listing-claim-support";
import { z } from "zod";
import {
  enrichmentFields,
  claimCopyFields,
  enrichmentIdentitySchema,
  enrichmentUrlSchema,
} from "@wukong/core";
import type { Database } from "@wukong/db";
import {
  retrieveListingEvidence,
  adoptListingEvidence,
  rejectListingEvidence,
  acceptWebsiteClaim,
  confirmWebsiteProse,
  evidenceView,
  observeEnrichmentInputs,
} from "./listing-enrichment-service";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "./route-support";
import type { SessionContextPort } from "./session-context-port";
import type { PublicFetch } from "./website/public-fetch";
const observation = {
  expectedInputRevision: z.number().int().positive(),
  baseVersionId: z.uuid().nullable(),
};
const retrieveBody = z
  .object({
    ...observation,
    url: enrichmentUrlSchema,
    identity: enrichmentIdentitySchema,
  })
  .strict();
const adoptBody = z
  .object({
    ...observation,
    selectedFields: z.array(z.enum(enrichmentFields)).min(1).max(9),
  })
  .strict();
export function createListingEnrichmentHandler(
  deps: {
    sessionContext: SessionContextPort;
    getDatabase: () => Pick<Database, "forWorkspace">;
    fetch?: PublicFetch;
    wait?: (ms: number) => Promise<void>;
  },
  action:
    | "retrieve"
    | "read"
    | "latest"
    | "adopt"
    | "reject"
    | "accept_claim"
    | "reject_claim"
    | "confirm_prose",
) {
  return (
    request: Request,
    context: { params: Promise<{ id: string; suggestionId?: string }> },
  ) =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (
        !["read", "latest"].includes(action) &&
        !["operator", "reviewer", "admin", "owner"].includes(session.role)
      )
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      const { id, suggestionId } = await context.params;
      if (!z.uuid().safeParse(id).success)
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const database = deps.getDatabase();
      const scope = {
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        listingId: id,
      };
      if (action === "retrieve") {
        const body = retrieveBody.parse(await request.json());
        const operationKey = z
          .uuid()
          .parse(request.headers.get("Idempotency-Key"));
        const suggestion = await retrieveListingEvidence(
          { ...scope, ...body, operationKey },
          { database, fetch: deps.fetch, wait: deps.wait },
        );
        return jsonResponse(
          200,
          await database.forWorkspace(
            session.workspaceId,
            async (r) =>
              await supportView(
                r,
                suggestion,
                await observeEnrichmentInputs(r, id),
              ),
          ),
        );
      }
      if (action === "latest")
        return database.forWorkspace(session.workspaceId, async (r) => {
          if (!(await r.listingEnrichment.isReady()))
            throw new ApiError(
              503,
              "enrichment_setup_required",
              "Evidence lookup setup is required.",
            );
          const current = await observeEnrichmentInputs(r, id);
          const suggestion = await r.listingEnrichment.latest(id);
          const response = jsonResponse(200, {
            suggestion: suggestion
              ? await supportView(r, suggestion, current)
              : null,
          });
          response.headers.set("Cache-Control", "private, no-store");
          return response;
        });
      if (!z.uuid().safeParse(suggestionId).success)
        throw new ApiError(
          404,
          "suggestion_not_found",
          "Suggestion not found.",
        );
      return database.forWorkspace(session.workspaceId, async (r) => {
        if (!(await r.listingEnrichment.isReady()))
          throw new ApiError(
            503,
            "enrichment_setup_required",
            "Evidence lookup setup is required.",
          );
        if (action === "read") {
          const suggestion = await r.listingEnrichment.get(id, suggestionId!);
          if (!suggestion)
            throw new ApiError(
              404,
              "suggestion_not_found",
              "Suggestion not found.",
            );
          const response = jsonResponse(
            200,
            evidenceView(suggestion, await observeEnrichmentInputs(r, id)),
          );
          response.headers.set("Cache-Control", "private, no-store");
          return response;
        }
        if (action === "confirm_prose") {
          const body = z
            .object({
              ...observation,
              copyField: z.enum(claimCopyFields),
              claimText: z.string().trim().min(5).max(500),
              reason: z.string().trim().min(20).max(1000),
            })
            .strict()
            .parse(await request.json());
          const operationKey = z
            .uuid()
            .parse(request.headers.get("Idempotency-Key"));
          return jsonResponse(
            200,
            await confirmWebsiteProse(r, {
              ...scope,
              ...body,
              suggestionId: suggestionId!,
              operationKey,
            }),
          );
        }
        if (action === "reject_claim") {
          const body = z
            .object({
              ...observation,
              claimIndex: z.number().int().min(0).max(20),
            })
            .strict()
            .parse(await request.json());
          const operationKey = z
            .uuid()
            .parse(request.headers.get("Idempotency-Key"));
          return jsonResponse(
            200,
            await rejectListingEvidence(r, {
              ...scope,
              expectedInputRevision: body.expectedInputRevision,
              baseVersionId: body.baseVersionId,
              selectedFields: ["claim:" + body.claimIndex],
              suggestionId: suggestionId!,
              operationKey,
            }),
          );
        }
        if (action === "accept_claim") {
          const body = z
            .object({
              ...observation,
              claimIndex: z.number().int().min(0).max(20),
              copyField: z.enum(claimCopyFields),
            })
            .strict()
            .parse(await request.json());
          const operationKey = z
            .uuid()
            .parse(request.headers.get("Idempotency-Key"));
          return jsonResponse(
            200,
            await acceptWebsiteClaim(r, {
              ...scope,
              ...body,
              suggestionId: suggestionId!,
              operationKey,
            }),
          );
        }
        const body = adoptBody.parse(await request.json());
        const operationKey = z
          .uuid()
          .parse(request.headers.get("Idempotency-Key"));
        if (action === "reject")
          return jsonResponse(
            200,
            await rejectListingEvidence(r, {
              ...scope,
              ...body,
              suggestionId: suggestionId!,
              operationKey,
            }),
          );
        const saved = await adoptListingEvidence(r, {
          ...scope,
          ...body,
          suggestionId: suggestionId!,
          operationKey,
        });
        return jsonResponse(200, { inputRevision: saved.revision });
      });
    });
}

async function supportView(
  repos: Parameters<typeof readCopyClaimSupports>[0],
  suggestion: Parameters<typeof evidenceView>[0],
  current: Parameters<typeof evidenceView>[1],
) {
  return {
    ...evidenceView(suggestion, current),
    acceptedClaims: await readCopyClaimSupports(
      repos,
      suggestion.listingId,
      current.workingContent as unknown as Record<string, unknown>,
    ),
  };
}
