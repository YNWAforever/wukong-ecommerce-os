import {
  prepareWineAdmission,
  recoverableWineAdmission,
  type WineAdmissionContext,
} from "../../../lib/wine-enrichment-service";
import { preflightWineCapability } from "../../../lib/wine-capability-client";
import { requireListingRecovery } from "../../../lib/listing-recovery-readiness";
import { createHash } from "node:crypto";
import { acceptListingOperation } from "../../../lib/listing-operation-service";
import { dispatchListingOperation } from "../../../lib/dispatch-listing-operation";
import { readSourceReadiness } from "../../../lib/source-readiness";
import { z } from "zod";
import {
  isImageMimeType,
  MAX_LISTING_IMAGES,
  MAX_LISTING_PDFS,
} from "@wukong/assets";
import type { WorkspaceRepositories } from "@wukong/db";

import type { ListingReviewContext } from "../../../lib/dashboard-queue-shared";
import { allConfirmed } from "../../../lib/review-confirmation-keys";

import { getAssetStore, getDatabase } from "../../../lib/intake-runtime";
import type { IntakeRouteDeps } from "../../../lib/intake-route-deps";
import { listingPublisher } from "../../../lib/listing-queue-runtime";
import {
  acceptSourceWithoutDecoding,
  requestProductShotFromProcess,
  type ProductShotRequestInput,
  type ProductShotRequestResult,
} from "../../../lib/product-shot-request";
import {
  ApiError,
  jsonResponse,
  queueIngressReason,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";

const listingSchema = z
  .object({
    sourceAssetIds: z
      .array(z.string().uuid())
      .max(11)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Asset IDs must be unique",
      ),
    note: z.string().max(5_000).optional().default(""),
    processingMode: z.enum(["ai", "manual"]).default("ai"),
    wineMode: z.enum(["full", "research", "copy", "section"]).optional(),
  })
  .strict()
  .refine(
    (body) => body.sourceAssetIds.length > 0 || body.note.trim().length > 0,
    "Add a source or a note.",
  );

type CreateListingDeps = IntakeRouteDeps<true> & {
  preflightWineCapability?: typeof preflightWineCapability;
  /**
   * Optional so tests can leave image work out. Production wires the same
   * requester the process route uses -- see the dispatch below for why creating
   * a listing has to start image work at all.
   */
  requestProductShot?: (
    input: ProductShotRequestInput,
  ) => Promise<ProductShotRequestResult>;
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
export function createListingHandler(deps: CreateListingDeps) {
  return async function createListing(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const body = listingSchema.parse(await request.json());

      const requestKey = request.headers.get("Idempotency-Key");
      if (requestKey) z.string().uuid().parse(requestKey);
      if (body.sourceAssetIds.length === 0 && !requestKey)
        throw new ApiError(
          400,
          "idempotency_key_required",
          "A request key is required for a note-only draft.",
        );
      await requireListingRecovery(deps.getDatabase());
      const wineAdmission =
        body.processingMode === "ai"
          ? await prepareWineAdmission(
              deps.getDatabase(),
              context.workspaceId,
              body.wineMode,
              deps.preflightWineCapability,
            )
          : {};
      const createDigest = createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex");
      const acceptedCreate = await deps
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
              return { ...prior.response, replayed: true } as any;
            }
          }
          const finish = async (value: any) => {
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
          // exotic one: the operator sees nothing happen and clicks again.
          // Assets are single-use, so the previous attempt had already claimed
          // them and the retry was answered with 409 -- leaving the listing
          // stranded, reachable only by someone who knew to go looking for it.
          //
          // The asset set is itself the natural idempotency key. If EVERY
          // requested asset is already attached to one and the same listing,
          // this is that listing being created again, so return it. Anything
          // else -- a partial overlap, assets split across listings -- is a
          // genuine conflict and still refuses.
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
            // Same assets but different words is a different request wearing
            // the same key. Returning the old listing would silently discard
            // what the operator just typed, so say so instead.
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
                    },
                    wineAdmission,
                  );
            return finish({ listing: existing, ...admission, snapshot });
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
                  },
                  wineAdmission,
                );
          return finish({ listing: created, ...admission, snapshot });
        });

      const { listing, accepted, snapshot, blocked } = acceptedCreate;
      if (accepted && !acceptedCreate.replayed)
        await dispatchListingOperation(
          deps.getDatabase(),
          context.workspaceId,
          accepted,
          deps.publisher,
        );
      const processing = accepted?.processing ?? null;
      let productShot: ProductShotRequestResult | undefined;
      if (
        accepted &&
        accepted.flowVersion !== "wine-enrichment-v1" &&
        !acceptedCreate.replayed &&
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

      return jsonResponse(201, {
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
      });
    });
  };
}

type ListListingsDeps = {
  sessionContext: IntakeRouteDeps["sessionContext"];
  getDatabase: IntakeRouteDeps["getDatabase"];
};

async function readQueueReviewContext(
  item: {
    id: string;
    status: string;
    activeVersion: { id: string } | null;
    openBlockingFlagCount: number;
  },
  repositories: Pick<
    WorkspaceRepositories,
    "reviewConfirmations" | "platformProducts"
  >,
): Promise<ListingReviewContext | null> {
  if (
    item.status !== "in_review" ||
    item.openBlockingFlagCount !== 0 ||
    !item.activeVersion
  )
    return null;

  const confirmation = await repositories.reviewConfirmations.getByVersionId(
    item.activeVersion.id,
  );
  if (
    !confirmation ||
    confirmation.listingId !== item.id ||
    confirmation.versionId !== item.activeVersion.id ||
    !Number.isInteger(confirmation.revision) ||
    confirmation.revision < 0 ||
    !allConfirmed(
      confirmation.fieldConfirmations,
      confirmation.negativeConfirmations,
    )
  )
    return null;

  const reviewContext: ListingReviewContext = {
    expectedVersionId: item.activeVersion.id,
    confirmationLedgerRevision: confirmation.revision,
  };
  const link = await repositories.platformProducts.getByListingId(item.id);
  if (
    link?.origin !== "import" &&
    (confirmation.sourceImportId != null || confirmation.rowDigest != null)
  )
    return null;
  if (link?.origin === "import") {
    // Expose the source bound to the completed checklist only while it still
    // matches the current import. Refreshing the queue must not rebind a stale
    // checklist to new source data.
    if (
      !confirmation.sourceImportId ||
      !confirmation.rowDigest ||
      confirmation.sourceImportId !== link.sourceImportId ||
      confirmation.rowDigest !== link.contentDigest
    )
      return null;
    reviewContext.expectedSourceImportId = confirmation.sourceImportId;
    reviewContext.expectedRowDigest = confirmation.rowDigest;
  }
  return reviewContext;
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(21474836).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  q: z.string().trim().optional(),
  status: z
    .enum([
      "received",
      "processing",
      "needs_info",
      "in_review",
      "approved",
      "publishing",
      "published",
      "publish_failed",
      "failed",
      "reopened",
    ])
    .optional(),
});
export function createListListingsHandler(deps: ListListingsDeps) {
  return async function listListings(request?: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const query = listQuerySchema.parse(
        Object.fromEntries(
          new URL(request?.url ?? "http://local/api/listings").searchParams,
        ),
      );
      const { items, counts, totalMatching } = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const page = await repositories.reads.listingPage(query);
          const hydrated = await repositories.listings.getByIds(page.ids);
          const byId = new Map(hydrated.map((item) => [item.id, item]));
          const items = page.ids.flatMap((id) =>
            byId.has(id) ? [byId.get(id)!] : [],
          );
          const counts = await repositories.listings.countByStatus();
          const reviewedItems = await Promise.all(
            items.map(async (item) => ({
              ...item,
              reviewContext: await readQueueReviewContext(item, repositories),
              sourceReadiness: await readSourceReadiness(
                repositories,
                context.workspaceId,
                item.id,
              ),
            })),
          );
          return {
            items: reviewedItems,
            counts,
            totalMatching: page.totalMatching,
          };
        });

      return jsonResponse(200, {
        counts,
        page: query.page,
        pageSize: query.pageSize,
        totalMatching,
        scope: "workspace",
        items: items.map((item) => {
          const content = item.activeVersion?.content as
            | {
                sku?: string;
                title?: { en?: string; "zh-Hant"?: string };
              }
            | undefined;
          const title =
            content?.title?.["zh-Hant"] ??
            content?.title?.en ??
            item.note ??
            "\u672a\u547d\u540d\u5546\u54c1";
          const updatedAt =
            item.updatedAt instanceof Date
              ? item.updatedAt.toISOString()
              : new Date(item.updatedAt).toISOString();
          return {
            id: item.id,
            status: item.status,
            target: item.target,
            title,
            sku: content?.sku ?? null,
            updatedAt,
            openBlockingFlagCount: item.openBlockingFlagCount,
            reviewContext: item.reviewContext,
            sourceReadiness: item.sourceReadiness,
          };
        }),
      });
    });
  };
}

export const GET = createListListingsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
export const POST = createListingHandler({
  sessionContext: authSessionContext,
  getAssetStore,
  getDatabase,
  publisher: listingPublisher,
  // Deliberately NOT the decoding validator. It imports `sharp`, and a native
  // module in this route's graph is what shipped 500s from the admin panel's
  // home page once already -- Next's tracer cannot follow sharp's dlopen(), so
  // libvips is dropped from the bundle and the route dies at runtime while
  // building clean. `tests/sharp-native-bundling.test.mjs` guards this route
  // specifically. See `acceptSourceWithoutDecoding` for what that costs.
  requestProductShot: (input) =>
    requestProductShotFromProcess(input, acceptSourceWithoutDecoding),
});
