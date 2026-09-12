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
      .min(1)
      .max(11)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Asset IDs must be unique",
      ),
    note: z.string().max(5_000).optional().default(""),
  })
  .strict();

type CreateListingDeps = IntakeRouteDeps<true> & {
  /**
   * Optional so tests can leave image work out. Production wires the same
   * requester the process route uses -- see the dispatch below for why creating
   * a listing has to start image work at all.
   */
  requestProductShot?: (
    input: ProductShotRequestInput,
  ) => Promise<ProductShotRequestResult>;
};

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

      const listing = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
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
            return existing;
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
          return created;
        });

      let processing:
        | { state: "queued"; jobId: string; errorCode: null }
        | {
            state: "retry_required";
            jobId: null;
            errorCode: "queue_unavailable";
          };

      // Image work starts here, not only when someone re-processes. Creating a
      // listing from photographs used to enqueue the listing job alone, so no
      // product shot existed until an operator happened to open the review
      // screen and ask for one -- on the one path where the photos had just
      // been uploaded. The two are dispatched together and independently: a
      // shot that cannot start (provider disabled, queue unconfigured) answers
      // `setup_required` and never blocks the text draft.
      let productShot: ProductShotRequestResult | undefined;
      try {
        const [textResult, shotResult] = await Promise.allSettled([
          deps.publisher.enqueue({
            workspaceId: context.workspaceId,
            draftId: listing.id,
            activeVersionSequence: 0,
          }),
          deps.requestProductShot?.({
            workspaceId: context.workspaceId,
            listingId: listing.id,
            actorId: context.actorId,
          }) ?? Promise.resolve(undefined),
        ]);
        productShot =
          shotResult.status === "fulfilled"
            ? shotResult.value
            : { state: "request_failed" };
        if (textResult.status === "rejected") throw textResult.reason;
        const job = textResult.value;
        processing = { state: "queued", jobId: job.id, errorCode: null };
        console.info(
          JSON.stringify({
            event: "listing.enqueue_accepted",
            workspaceId: context.workspaceId,
            listingId: listing.id,
            jobId: job.id,
          }),
        );
      } catch (error) {
        processing = {
          state: "retry_required",
          jobId: null,
          errorCode: "queue_unavailable",
        };
        // The draft is deliberately kept and the request still succeeds, so
        // this log is the only record of why the queue could not take it.
        // Without the reason, an unset variable and an unreachable Worker are
        // the same line.
        console.error(
          JSON.stringify({
            event: "listing.enqueue_failed",
            workspaceId: context.workspaceId,
            listingId: listing.id,
            errorCode: "queue_unavailable",
            queueReason: queueIngressReason(error) ?? "unknown",
          }),
        );
      }

      return jsonResponse(201, {
        listing: {
          id: listing.id,
          status: listing.status,
          target: listing.target,
        },
        processing,
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
