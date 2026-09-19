import { sectionKeySchema } from "@wukong/core";
import {
  prepareWineAdmission,
  recoverableWineAdmission,
} from "../../../../../lib/wine-enrichment-service";
import { preflightWineCapability } from "../../../../../lib/wine-capability-client";
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
    baseVersionId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase())
      .nullable(),
    note: z.string().trim().max(5000).nullable().optional(),
    sources: z
      .array(
        sourceSelectionSchema.transform((source) => ({
          ...source,
          assetId: source.assetId.toLowerCase(),
        })),
      )
      .max(11)
      .optional(),
    changes: z.array(workingChangeSchema).max(100).default([]),
    action: z.enum(["save", "save_and_process"]).default("save"),
    wineMode: z.enum(["full", "research", "copy", "section"]).optional(),
    wineSection: sectionKeySchema.optional(),
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
  preflightWineCapability?: typeof preflightWineCapability;
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
      const { id: requestedId } = await context.params;
      const id = requestedId.toLowerCase();
      if (!z.string().uuid().safeParse(id).success)
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const body = bodySchema.parse(await request.json());
      const operationKey = z
        .string()
        .uuid()
        .transform((value) => value.toLowerCase())
        .parse(request.headers.get("Idempotency-Key"));
      await requireListingRecovery(deps.getDatabase());
      const wineAdmission =
        body.action === "save_and_process"
          ? await prepareWineAdmission(
              deps.getDatabase(),
              session.workspaceId,
              body.wineMode,
              deps.preflightWineCapability,
            )
          : {};
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
            let accepted = null;
            let processingBlocked: { code: string; message: string } | null =
              null;
            if (body.action === "save_and_process") {
              try {
                accepted = await (
                  deps.acceptProcessing ?? acceptListingOperation
                )(
                  repos,
                  {
                    workspaceId: session.workspaceId,
                    listingId: id,
                    expectedInputRevision: saved.revision,
                    baseVersionId: saved.baseVersionId,
                    operationKey,
                    actorId: session.actorId,
                    wineMode: body.wineMode,
                    wineSection: body.wineSection,
                  },
                  wineAdmission,
                );
              } catch (error) {
                if (!recoverableWineAdmission(error)) throw error;
                processingBlocked = {
                  code: error.code,
                  message: error.message,
                };
              }
            }
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
                ...(processingBlocked ? { processingBlocked } : {}),
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
          body.action === "save_and_process" && !result.body.processingBlocked
            ? 202
            : 200,
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
