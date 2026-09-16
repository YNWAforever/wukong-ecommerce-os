import { requireListingRecovery } from "../../../../../lib/listing-recovery-readiness";
import { dispatchListingOperation } from "../../../../../lib/dispatch-listing-operation";
import {
  listingPublisher,
  type ListingPublisher,
} from "../../../../../lib/listing-queue-runtime";
import { z } from "zod";
import {
  workingChangeSchema,
  sourceSelectionSchema,
  reviewableListingSchema,
} from "@wukong/core";
import { listingInputDigest, type Database } from "@wukong/db";
import { getDatabase } from "../../../../../lib/intake-runtime";
import { acceptListingOperation } from "../../../../../lib/listing-operation-service";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";
const bodySchema = z
  .object({
    expectedInputRevision: z.number().int().nonnegative(),
    baseVersionId: z.string().uuid().nullable(),
    note: z.string().trim().max(5000).nullable().optional(),
    sources: z.array(sourceSelectionSchema).max(11).optional(),
    changes: z.array(workingChangeSchema).max(100).default([]),
    action: z.enum(["save", "save_and_process"]).default("save"),
  })
  .strict();
export function mapListingInputError(error: unknown): never {
  const code = (error as { code?: string })?.code;
  if (code && ["listing_not_found", "source_not_found"].includes(code))
    throw new ApiError(404, code, "Listing or source not found.");
  if (
    code &&
    [
      "input_revision_conflict",
      "base_version_conflict",
      "idempotency_conflict",
      "source_not_finalized",
      "listing_busy",
    ].includes(code)
  )
    throw new ApiError(
      409,
      code,
      "The saved inputs changed or are unavailable. Reload before saving.",
    );
  if (code === "invalid_sources")
    throw new ApiError(
      400,
      code,
      "Choose valid source roles and at most one hero image.",
    );
  throw error;
}
export function createListingInputsHandler(deps: {
  sessionContext: SessionContextPort;
  getDatabase: () => Pick<Database, "forWorkspace">;
  acceptProcessing?: typeof acceptListingOperation;
  publisher?: ListingPublisher;
}) {
  return async (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!["operator", "reviewer", "admin", "owner"].includes(session.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      const { id } = await context.params;
      if (!z.string().uuid().safeParse(id).success)
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const body = bodySchema.parse(await request.json());
      const operationKey = z
        .string()
        .uuid()
        .parse(request.headers.get("Idempotency-Key"));
      await requireListingRecovery(deps.getDatabase());
      try {
        const result = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repos) => {
            const saved = await repos.listingInputs.save(
              {
                ...body,
                listingId: id,
                actorId: session.actorId,
                operationKey,
                requestDigest: listingInputDigest(body),
              },
              {
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: id,
              },
              repos.audit,
            );
            const accepted =
              body.action === "save_and_process"
                ? await (deps.acceptProcessing ?? acceptListingOperation)(
                    repos,
                    {
                      workspaceId: session.workspaceId,
                      listingId: id,
                      expectedInputRevision: saved.revision,
                      baseVersionId: saved.baseVersionId,
                      operationKey,
                      actorId: session.actorId,
                    },
                  )
                : null;
            return {
              accepted,
              body: {
                listingId: id,
                inputRevision: saved.revision,
                activeVersionId: saved.baseVersionId,
                documentState: reviewableListingSchema.safeParse(
                  saved.workingContent,
                ).success
                  ? "reviewable"
                  : "partial",
                processing: accepted?.processing ?? null,
              },
            };
          });
        if (result.accepted && deps.publisher)
          await dispatchListingOperation(
            deps.getDatabase(),
            session.workspaceId,
            result.accepted,
            deps.publisher,
          );
        return jsonResponse(
          body.action === "save_and_process" ? 202 : 200,
          result.body,
        );
      } catch (error) {
        mapListingInputError(error);
      }
    });
}
export const PATCH = createListingInputsHandler({
  sessionContext: authSessionContext,
  getDatabase,
  publisher: listingPublisher,
});
