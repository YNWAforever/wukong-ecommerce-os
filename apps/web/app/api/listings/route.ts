import { z } from "zod";
import type { WorkspaceRepositories } from "@wukong/db";

import type { ListingReviewContext } from "../../../lib/dashboard-queue-shared";
import { allConfirmed } from "../../../lib/review-confirmation-keys";

import { getAssetStore, getDatabase } from "../../../lib/intake-runtime";
import type { IntakeRouteDeps } from "../../../lib/intake-route-deps";
import { listingPublisher } from "../../../lib/listing-queue-runtime";
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

export function createListingHandler(deps: IntakeRouteDeps<true>) {
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
          if (assets.some(({ listingId }) => listingId !== null)) {
            throw new ApiError(
              409,
              "source_asset_already_used",
              "One or more source assets are already associated.",
            );
          }

          const imageKinds = new Set(["image/jpeg", "image/png", "image/webp"]);
          const imageCount = assets.filter(({ kind }) =>
            imageKinds.has(kind),
          ).length;
          const pdfCount = assets.filter(
            ({ kind }) => kind === "application/pdf",
          ).length;
          if (
            imageCount > 10 ||
            pdfCount > 1 ||
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

      try {
        const job = await deps.publisher.enqueue({
          workspaceId: context.workspaceId,
          draftId: listing.id,
          activeVersionSequence: 0,
        });
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

export function createListListingsHandler(deps: ListListingsDeps) {
  return async function listListings(): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const { items, counts } = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const items = await repositories.listings.listRecent(100);
          const counts = await repositories.listings.countByStatus();
          const reviewedItems = await Promise.all(
            items.map(async (item) => ({
              ...item,
              reviewContext: await readQueueReviewContext(item, repositories),
            })),
          );
          return { items: reviewedItems, counts };
        });

      return jsonResponse(200, {
        counts,
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
});
