import { createHash } from "node:crypto";

import {
  isImageMimeType,
  MAX_LISTING_IMAGES,
  MAX_LISTING_PDFS,
} from "@wukong/assets";
import { sectionKeySchema } from "@wukong/core";
import type { Database, WorkspaceRepositories } from "@wukong/db";
import { listingJobSchema, wineListingJobSchema } from "@wukong/jobs";
import { z } from "zod";

import { requireListingRecovery } from "./listing-recovery-readiness";
import { acceptListingOperation } from "./listing-operation-service";
import type { AcceptedListingOperation } from "./listing-operation-service";
import type { ListingPublisher } from "./listing-queue-runtime";
import type {
  ProductShotRequestInput,
  ProductShotRequestResult,
} from "./product-shot-request";
import { ApiError } from "./route-support";
import type { SessionContext } from "./session-context-port";
import { requireWorkspaceRole } from "./session-context";
import type { preflightWineCapability } from "./wine-capability-client";
import {
  prepareWineAdmission,
  recoverableWineAdmission,
  type WineAdmissionContext,
} from "./wine-enrichment-service";

/**
 * Listing intake service (plan Task 10).
 *
 * This is the create-listing flow that used to live inside
 * `createListingHandler`, extracted so a second caller (the Studio dispatch
 * route) can reuse it without importing the listings route module. That import
 * is the one Next's file tracer cannot follow safely (the route's product-shot
 * dependency chain), and `tests/sharp-native-bundling.test.mjs` guards it.
 *
 * Behaviour is deliberately unchanged for `POST /api/listings`: the route still
 * owns HTTP concerns (session, body parse, idempotency header, status codes),
 * while the domain decisions (recovery gate, wine admission, asset checks,
 * listing + input snapshot creation, outbox dispatch, product-shot hand-off)
 * live here. The one addition is a `queueState` field so the Studio dispatch
 * route can say honestly whether the existing pipeline actually started; the
 * listings route ignores it, which preserves its response body exactly.
 */

export const listingIntakeBodySchema = z
  .object({
    sourceAssetIds: z
      .array(
        z
          .string()
          .uuid()
          .transform((value) => value.toLowerCase()),
      )
      .max(11)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Asset IDs must be unique",
      ),
    note: z.string().max(5_000).optional().default(""),
    processingMode: z.enum(["ai", "manual"]).default("ai"),
    wineMode: z.enum(["full", "research", "copy", "section"]).optional(),
    wineSection: sectionKeySchema.optional(),
  })
  .strict()
  .refine(
    (body) => body.sourceAssetIds.length > 0 || body.note.trim().length > 0,
    "Add a source or a note.",
  );
export type ListingIntakeBody = z.infer<typeof listingIntakeBodySchema>;

export type ListingIntakeDeps = {
  getDatabase: () => Pick<Database, "forWorkspace">;
  publisher: ListingPublisher;
  preflightWineCapability?: typeof preflightWineCapability;
  requestProductShot?: (
    input: ProductShotRequestInput,
  ) => Promise<ProductShotRequestResult>;
};

export type ListingIntakeResult = {
  listing: { id: string; status: string; target: string };
  inputRevision: number;
  activeVersionId: string | null;
  processing: AcceptedListingOperation["processing"] | null;
  processingBlocked?: { code: string; message: string };
  productShot?: ProductShotRequestResult;
  replayed: boolean;
  /**
   * The asset set already belonged to one listing (a lost-response retry).
   * The original intake path **re-enqueues** in this case on purpose — the
   * first attempt's enqueue may have failed — so callers that audit a dispatch
   * must not treat this as a duplicate request.
   */
  reusedExisting: boolean;
  /**
   * `enqueued` only when every recorded outbox row was confirmed by the queue.
   * `queue_unavailable` means the listing exists and processing has not
   * started (blocked admission, an empty/admission-only create, or a failed
   * enqueue). Callers must never describe this as "processing".
   */
  queueState: "enqueued" | "queue_unavailable";
};

type IntakeSnapshot = Awaited<
  ReturnType<WorkspaceRepositories["listingInputs"]["initialize"]>
>;
type CreatedListing = Awaited<
  ReturnType<WorkspaceRepositories["listings"]["create"]>
>;

type AcceptedCreate = {
  listing: CreatedListing;
  accepted: AcceptedListingOperation | null;
  blocked: { code: string; message: string } | null;
  snapshot: IntakeSnapshot;
};

const recoverableAdmission = new Set([
  "ai_configuration_required",
  "provider_capability",
  "budget_blocked",
]);

async function acceptOrSave(
  repositories: WorkspaceRepositories,
  input: Parameters<typeof acceptListingOperation>[1],
  admission: WineAdmissionContext,
) {
  try {
    return {
      accepted: await acceptListingOperation(repositories, input, admission),
      blocked: null,
    };
  } catch (error) {
    if (
      recoverableWineAdmission(error) ||
      (error instanceof ApiError && recoverableAdmission.has(error.code))
    )
      return {
        accepted: null,
        blocked: { code: error.code, message: error.message },
      };
    throw error;
  }
}

/**
 * Send the accepted operation's outbox rows and report whether the queue
 * accepted all of them.
 *
 * This mirrors `dispatchListingOperation` (the post-commit helper used by the
 * wine route), but keeps the per-row outcome instead of swallowing it: the
 * Studio dispatch route must be able to say "created, processing has not
 * started" rather than inventing success. Recovery authority is unchanged —
 * attempted-but-unconfirmed rows stay in the outbox for the existing recovery
 * path.
 */
async function dispatchAcceptedOperation(input: {
  database: Pick<Database, "forWorkspace">;
  workspaceId: string;
  accepted: AcceptedListingOperation;
  publisher: ListingPublisher;
}): Promise<"enqueued" | "queue_unavailable"> {
  let unavailable = false;
  for (const row of input.accepted.outbox) {
    try {
      const job = listingJobSchema.or(wineListingJobSchema).parse(row.payload);
      if (
        job.workspaceId !== input.workspaceId ||
        (job.runId && job.runId !== input.accepted.run.id)
      )
        throw new Error("operation outbox mismatch");
      await input.publisher.enqueue(job);
      await input.database.forWorkspace(input.workspaceId, (repos) =>
        repos.dispatchOutbox.markDispatched([row.id]),
      );
    } catch {
      unavailable = true;
      try {
        await input.database.forWorkspace(input.workspaceId, (repos) =>
          repos.dispatchOutbox.markAttempted([row.id]),
        );
      } catch {
        /* The committed outbox remains the recovery authority. */
      }
      console.info(
        JSON.stringify({
          event: "listing.dispatch_pending",
          runId: input.accepted.run.id,
        }),
      );
    }
  }
  return unavailable ? "queue_unavailable" : "enqueued";
}

/**
 * Create one listing draft through the reviewed intake path.
 *
 * Rejects a non-operator before any read or write; assets are resolved inside
 * the workspace transaction, so a foreign id can only produce the same 404 a
 * foreign listing id would. `requestKey` is the HTTP idempotency key (the route
 * supplies it); the asset set itself is the natural key for asset-backed
 * creates, exactly as before.
 */
export async function createListingIntake(
  deps: ListingIntakeDeps,
  input: {
    context: SessionContext;
    body: ListingIntakeBody;
    requestKey: string | null;
  },
): Promise<ListingIntakeResult> {
  const { context, body, requestKey } = input;
  if (!requireWorkspaceRole("operator", context.role))
    throw new ApiError(
      403,
      "insufficient_role",
      "Operator access is required.",
    );

  await requireListingRecovery(deps.getDatabase());
  const wineAdmission =
    body.processingMode === "ai"
      ? await prepareWineAdmission(
          deps.getDatabase() as Database,
          context.workspaceId,
          body.wineMode,
          deps.preflightWineCapability,
        )
      : {};
  const createDigest = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  const acceptedCreate: AcceptedCreate & {
    replayed?: boolean;
    reused?: boolean;
  } = await deps
    .getDatabase()
    .forWorkspace(context.workspaceId, async (repositories) => {
      await repositories.pipelineRuns.lockCreateRequests(
        requestKey,
        body.sourceAssetIds,
      );
      if (requestKey) {
        const prior =
          await repositories.pipelineRuns.findCreateRequest(requestKey);
        if (prior) {
          if (prior.digest !== createDigest)
            throw new ApiError(
              409,
              "idempotency_conflict",
              "This request key has different inputs.",
            );
          return { ...prior.response, replayed: true } as unknown as AcceptedCreate & {
            replayed: true;
          };
        }
      }
      const finish = async (
        value: AcceptedCreate & { replayed?: boolean; reused?: boolean },
      ) => {
        if (requestKey)
          await repositories.pipelineRuns.recordCreateRequest(
            requestKey,
            createDigest,
            value.listing.id,
            value,
          );
        return value;
      };
      const assets = await repositories.sourceAssets.getByIds(
        body.sourceAssetIds,
      );
      const foundIds = new Set(assets.map(({ id }) => id));
      if (
        assets.length !== body.sourceAssetIds.length ||
        body.sourceAssetIds.some((id) => !foundIds.has(id))
      ) {
        throw new ApiError(
          404,
          "source_assets_not_found",
          "One or more source assets were not found.",
        );
      }
      // A create whose response was lost is the common case here, not an
      // exotic one: the operator sees nothing happen and clicks again. Assets
      // are single-use, so the previous attempt had already claimed them and
      // the retry was answered with 409 -- leaving the listing stranded.
      const attached = assets.filter(({ listingId }) => listingId !== null);
      if (attached.length > 0) {
        const owners = new Set(attached.map(({ listingId }) => listingId));
        const owner = owners.size === 1 ? [...owners][0] : null;
        const existing =
          owner != null && attached.length === assets.length
            ? await repositories.listings.getById(owner)
            : null;
        if (!existing) {
          throw new ApiError(
            409,
            "source_asset_already_used",
            "One or more source assets are already associated.",
          );
        }
        if (existing.note !== (body.note.trim() || null)) {
          throw new ApiError(
            409,
            "source_asset_already_used",
            "These files already belong to another listing.",
          );
        }
        const snapshot = await repositories.listingInputs.initialize(
          { listingId: existing.id, actorId: context.actorId },
          { ...context, entityId: existing.id },
          repositories.audit,
        );
        const admission =
          body.processingMode === "manual"
            ? { accepted: null, blocked: null }
            : await acceptOrSave(
                repositories,
                {
                  ...context,
                  listingId: existing.id,
                  expectedInputRevision: snapshot.revision,
                  baseVersionId: snapshot.baseVersionId,
                  operationKey: `create:${existing.id}`,
                  wineMode: body.wineMode,
                  wineSection: body.wineSection,
                },
                wineAdmission,
              );
        return finish({
          listing: existing,
          ...admission,
          snapshot,
          reused: true,
        });
      }

      const imageCount = assets.filter(({ kind }) =>
        isImageMimeType(kind),
      ).length;
      const pdfCount = assets.filter(
        ({ kind }) => kind === "application/pdf",
      ).length;
      if (
        imageCount > MAX_LISTING_IMAGES ||
        pdfCount > MAX_LISTING_PDFS ||
        imageCount + pdfCount !== assets.length
      ) {
        throw new ApiError(
          400,
          "invalid_asset_composition",
          "Listings support up to 10 images and 1 PDF.",
        );
      }

      const created = await repositories.listings.create({
        target: "shopline",
        note: body.note.trim() || null,
      });
      await repositories.sourceAssets.attachToListing(
        created.id,
        body.sourceAssetIds,
      );
      await repositories.audit.write({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        entityId: created.id,
        action: "listing.created",
        metadata: {
          assetCount: body.sourceAssetIds.length,
          hasNote: body.note.trim().length > 0,
        },
      });
      const snapshot = await repositories.listingInputs.initialize(
        { listingId: created.id, actorId: context.actorId },
        { ...context, entityId: created.id },
        repositories.audit,
      );
      const admission =
        body.processingMode === "manual"
          ? { accepted: null, blocked: null }
          : await acceptOrSave(
              repositories,
              {
                ...context,
                listingId: created.id,
                expectedInputRevision: snapshot.revision,
                baseVersionId: null,
                operationKey: `create:${created.id}`,
                wineMode: body.wineMode,
                wineSection: body.wineSection,
              },
              wineAdmission,
            );
      return finish({ listing: created, ...admission, snapshot });
    });

  const { listing, accepted, snapshot, blocked } = acceptedCreate;
  const replayed = acceptedCreate.replayed === true;

  let queueState: ListingIntakeResult["queueState"] = "queue_unavailable";
  if (accepted && !replayed) {
    queueState = await dispatchAcceptedOperation({
      database: deps.getDatabase(),
      workspaceId: context.workspaceId,
      accepted,
      publisher: deps.publisher,
    });
  } else if (accepted && replayed) {
    // The run was accepted and dispatched by the earlier attempt.
    queueState = "enqueued";
  }

  const processing = accepted?.processing ?? null;
  let productShot: ProductShotRequestResult | undefined;
  if (
    accepted &&
    accepted.flowVersion !== "wine-enrichment-v1" &&
    !replayed &&
    body.processingMode === "ai" &&
    deps.requestProductShot
  ) {
    try {
      productShot = await deps.requestProductShot({
        workspaceId: context.workspaceId,
        listingId: listing.id,
        actorId: context.actorId,
      });
    } catch {
      productShot = { state: "request_failed" };
    }
  }

  return {
    listing: {
      id: listing.id,
      status: listing.status,
      target: listing.target,
    },
    inputRevision: snapshot.revision,
    activeVersionId: snapshot.baseVersionId,
    processing,
    ...(blocked ? { processingBlocked: blocked } : {}),
    ...(productShot ? { productShot } : {}),
    replayed,
    reusedExisting: acceptedCreate.reused === true,
    queueState,
  };
}
