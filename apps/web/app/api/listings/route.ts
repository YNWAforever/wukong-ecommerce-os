import { loadSourceReadinessBatch } from "../../../lib/source-readiness";
import { decodeReadCursor, encodeReadCursor } from "../../../lib/read-cursor";
import { z } from "zod";
import type { WorkspaceRepositories } from "@wukong/db";

import type { ListingReviewContext } from "../../../lib/dashboard-queue-shared";
import { allConfirmed } from "../../../lib/review-confirmation-keys";
import {
  readIsolatedListing,
  recordListingReadFailure,
} from "../../../lib/listing-read-resilience";

import { getAssetStore, getDatabase } from "../../../lib/intake-runtime";
import type { IntakeRouteDeps } from "../../../lib/intake-route-deps";
import { listingPublisher } from "../../../lib/listing-queue-runtime";
import {
  createListingIntake,
  listingIntakeBodySchema,
} from "../../../lib/listing-intake-service";
import {
  acceptSourceWithoutDecoding,
  requestProductShotFromProcess,
  type ProductShotRequestInput,
  type ProductShotRequestResult,
} from "../../../lib/product-shot-request";
import {
  ApiError,
  atRouteStage,
  createRouteDiagnostics,
  jsonResponse,
  queueIngressReason,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";

const listingSchema = listingIntakeBodySchema;

type CreateListingDeps = IntakeRouteDeps<true> & {
  preflightWineCapability?: typeof import("../../../lib/wine-capability-client").preflightWineCapability;
  /**
   * Optional so tests can leave image work out. Production wires the same
   * requester the process route uses -- creating a listing starts image work
   * for AI-mode creates.
   */
  requestProductShot?: (
    input: ProductShotRequestInput,
  ) => Promise<ProductShotRequestResult>;
};

/**
 * `POST /api/listings` -- create a listing draft from uploaded sources.
 *
 * The domain flow lives in `createListingIntake` (plan Task 10) so the Studio
 * dispatch route can reuse it without importing this module. This handler keeps
 * the HTTP contract exactly: operator floor, strict body schema, idempotency
 * header rules, 201 response shape.
 */
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

      const requestKey =
        request.headers.get("Idempotency-Key")?.toLowerCase() ?? null;
      if (requestKey) z.string().uuid().parse(requestKey);
      if (body.sourceAssetIds.length === 0 && !requestKey)
        throw new ApiError(
          400,
          "idempotency_key_required",
          "A request key is required for a note-only draft.",
        );

      const result = await createListingIntake(
        {
          getDatabase: deps.getDatabase,
          publisher: deps.publisher,
          ...(deps.preflightWineCapability
            ? { preflightWineCapability: deps.preflightWineCapability }
            : {}),
          ...(deps.requestProductShot
            ? { requestProductShot: deps.requestProductShot }
            : {}),
        },
        { context, body, requestKey },
      );

      return jsonResponse(201, {
        listing: result.listing,
        inputRevision: result.inputRevision,
        activeVersionId: result.activeVersionId,
        processing: result.processing,
        ...(result.processingBlocked
          ? { processingBlocked: result.processingBlocked }
          : {}),
        ...(result.productShot ? { productShot: result.productShot } : {}),
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
  cursor: z.string().min(1).max(1024).optional(),
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
    const diagnostics = createRouteDiagnostics();
    return withRouteErrors(async () => {
      const context = await atRouteStage("session", () =>
        requireSessionContext(deps.sessionContext),
      );
      const query = listQuerySchema.parse(
        Object.fromEntries(
          new URL(request?.url ?? "http://local/api/listings").searchParams,
        ),
      );
      const cursorScope = {
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        role: context.role,
        view: "listings",
        pageSize: query.pageSize,
        q: (query.q ?? "").trim().toLocaleLowerCase(),
        status: query.status ?? null,
      };
      const { cursor: token, ...pageQuery } = query;
      const cursor = decodeReadCursor(token, cursorScope);
      const { items, counts, totalMatching, nextCursor, previousCursor } =
        await deps
          .getDatabase()
          .forWorkspace(context.workspaceId, async (repositories) => {
            const page = await atRouteStage("listing", () =>
              repositories.reads.listingPage({
                ...pageQuery,
                ...(cursor ? { cursor } : {}),
              }),
            );
            const hydrated = await atRouteStage("listing", () =>
              repositories.listings.getByIds(page.ids),
            );
            const byId = new Map(hydrated.map((item) => [item.id, item]));
            const items = page.ids.flatMap((id) =>
              byId.has(id) ? [byId.get(id)!] : [],
            );
            const counts = await atRouteStage("listing", () =>
              repositories.listings.countByStatus(),
            );
            const sourceReader = await atRouteStage("sources", () =>
              loadSourceReadinessBatch(
                repositories,
                context.workspaceId,
                page.ids,
              ),
            );
            const reviewRepositories = {
              reviewConfirmations: {
                getByVersionId: sourceReader.deps.getReviewConfirmation,
              },
              platformProducts: {
                getByListingId: sourceReader.deps.getPlatformProductLink,
              },
            } as Pick<
              WorkspaceRepositories,
              "reviewConfirmations" | "platformProducts"
            >;
            const reviewedItems = await Promise.all(
              items.map(async (item) => {
                if (item.readFailure)
                  return {
                    ...item,
                    readState: "blocked" as const,
                    readFailure: recordListingReadFailure(
                      diagnostics,
                      "listing",
                      item.readFailure,
                    ),
                    reviewContext: null,
                    sourceReadiness: null,
                  };
                const review = await readIsolatedListing(
                  diagnostics,
                  "review",
                  () => readQueueReviewContext(item, reviewRepositories),
                );
                const source = await readIsolatedListing(
                  diagnostics,
                  "sources",
                  () => sourceReader.read(item.id),
                );
                if (
                  review.state === "unavailable" ||
                  source.state === "unavailable"
                )
                  return {
                    ...item,
                    readState: "blocked" as const,
                    readFailure:
                      review.state === "unavailable"
                        ? review.failure
                        : source.state === "unavailable"
                          ? source.failure
                          : undefined,
                    reviewContext: null,
                    sourceReadiness: null,
                  };
                return {
                  ...item,
                  readState: "ready" as const,
                  readFailure: undefined,
                  reviewContext: review.value,
                  sourceReadiness: source.value,
                };
              }),
            );
            return {
              items: reviewedItems,
              counts,
              totalMatching: page.totalMatching,
              nextCursor: page.nextCursor,
              previousCursor: page.previousCursor,
            };
          });

      return jsonResponse(200, {
        counts,
        page: query.page,
        pageSize: query.pageSize,
        totalMatching,
        nextCursor: encodeReadCursor(nextCursor, cursorScope),
        previousCursor: encodeReadCursor(previousCursor, cursorScope),
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
            readState: item.readState,
            ...(item.readFailure ? { readFailure: item.readFailure } : {}),
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
    }, diagnostics);
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
