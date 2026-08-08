import { z } from "zod";
import {
  ASSET_EXPORT_READ_TTL_MS,
  resolveListingImageUrls,
} from "@wukong/assets";
import {
  SHOPLINE_INGRESS_PATH,
  type ShoplinePublishJob,
} from "@wukong/jobs";

import {
  createCloudflareIngressClient,
  type CloudflareIngressClient,
} from "../../../../../lib/cloudflare-queue-runtime";
import { getAssetStore, getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import {
  confirmShoplineQueued,
  deliverListing,
  prepareShoplineDelivery,
  type DeliveryResult,
  type DeliverInput,
} from "../../../../../lib/delivery-service";

const bodySchema = z
  .object({ method: z.enum(["csv", "shopline_api"]) })
  .strict();
type RouteContext = { params: Promise<{ id: string }> };
type DeliveryPort = { deliver(input: DeliverInput): Promise<DeliveryResult> };
export type DeliverListingRouteDeps = {
  sessionContext: typeof authSessionContext;
  delivery: DeliveryPort;
};

function assertReviewer(role: string): void {
  if (!["reviewer", "admin", "owner"].includes(role))
    throw new ApiError(
      403,
      "insufficient_role",
      "Reviewer access is required.",
    );
}

function responseFor(result: DeliveryResult, listingId: string): Response {
  switch (result.kind) {
    case "csv":
      return new Response(result.body, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${listingId}-${result.specVersion}.csv"`,
        },
      });
    case "queued":
      return jsonResponse(202, {
        status: "queued",
        jobId: result.jobId,
        versionId: result.versionId,
      });
    case "retry_required":
      return jsonResponse(503, {
        code: "retry_required",
        message: "Queue ingress is temporarily unavailable; retry delivery.",
        jobId: result.jobId,
        versionId: result.versionId,
      });
    case "approval_required":
      throw new ApiError(
        409,
        "approval_required",
        "\u6279\u51c6\u5f8c\u624d\u53ef\u532f\u51fa\u6216\u4e0a\u67b6\u3002",
      );
    case "blocking_flags":
      throw new ApiError(
        422,
        "blocking_flags",
        "Unresolved blocking compliance flags remain.",
      );
    case "validation_error":
      throw new ApiError(
        422,
        "validation_error",
        "SHOPLINE payload validation failed.",
      );
    case "already_published":
      if (result.remoteProductId)
        return jsonResponse(200, {
          status: "published",
          remoteProductId: result.remoteProductId,
        });
      throw new ApiError(
        409,
        "published_delivery_missing",
        "Published listing has no stored delivery result.",
      );
    case "disconnected":
      return jsonResponse(409, {
        code: "shopline_disconnected",
        message: "SHOPLINE is not connected; use CSV fallback.",
        csvFallback: result.csvFallback,
      });
  }
}

export function createDeliverListingHandler(deps: DeliverListingRouteDeps) {
  return async function deliverListingHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id))
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const body = bodySchema.parse(await request.json());
      let result: DeliveryResult;
      try {
        result = await deps.delivery.deliver({
          workspaceId: session.workspaceId,
          actorId: session.actorId,
          draftId: id,
          method: body.method,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          /listing not found|foreign listing/i.test(error.message)
        )
          throw new ApiError(404, "listing_not_found", "Listing not found.");
        throw error;
      }
      return responseFor(result, id);
    });
  };
}

type DefaultDeliveryOptions = {
  ingressClient?: CloudflareIngressClient;
};

export function defaultDelivery(
  options: DefaultDeliveryOptions = {},
): DeliveryPort {
  const ingressClient =
    options.ingressClient ?? createCloudflareIngressClient();
  return {
    async deliver(input) {
      const database = getDatabase();
      const assetStore = getAssetStore();
      if (input.method === "csv") {
        return database.forWorkspace(
          input.workspaceId,
          async (repositories) => {
            return deliverListing(input, {
              listings: repositories.listings,
              imageUrls: (workspaceId, draftId, imageAssetIds) =>
                resolveListingImageUrls({
                  workspaceId,
                  draftId,
                  imageAssetIds,
                  sourceAssets: repositories.sourceAssets,
                  assetStore,
                  // The operator downloads this file and uploads it to SHOPLINE
                  // by hand. Ten minutes expires before SHOPLINE ever fetches
                  // the images.
                  readTtlMs: ASSET_EXPORT_READ_TTL_MS,
                }),
              audit: repositories.audit,
              publisher: {
                async enqueue() {
                  throw new Error("SHOPLINE API must use two-phase enqueue");
                },
              },
              connection: async () => {
                const connection = await repositories.shoplineConnections.getDefault();
                return connection ? { id: connection.id, verified: true } : null;
              },
              existingDelivery: (key) =>
                repositories.publishJobs.getByIdempotencyKey(key),
            });
          },
        );
      }

      const prepared = await database.forWorkspace(
        input.workspaceId,
        async (repositories) => {
          return prepareShoplineDelivery(input, {
            listings: repositories.listings,
            imageUrls: (workspaceId, draftId, imageAssetIds) =>
              resolveListingImageUrls({
                workspaceId,
                draftId,
                imageAssetIds,
                sourceAssets: repositories.sourceAssets,
                assetStore,
              }),
            audit: repositories.audit,
            publishJobs: repositories.publishJobs,
            connection: async () => {
              const connection = await repositories.shoplineConnections.getDefault();
              return connection ? { id: connection.id, verified: true } : null;
            },
            existingDelivery: (key) =>
              repositories.publishJobs.getByIdempotencyKey(key),
          });
        },
      );
      if (prepared.kind !== "publish_request") return prepared;

      try {
        const message: ShoplinePublishJob = {
          workspaceId: input.workspaceId,
          draftId: input.draftId,
          versionId: prepared.versionId,
          connectionId: prepared.connectionId,
        };
        await ingressClient.enqueue(SHOPLINE_INGRESS_PATH, message);
      } catch {
        return {
          kind: "retry_required",
          jobId: prepared.jobId,
          versionId: prepared.versionId,
        };
      }

      return database.forWorkspace(input.workspaceId, (repositories) =>
        confirmShoplineQueued(prepared, {
          publishJobs: repositories.publishJobs,
          audit: repositories.audit,
        }),
      );
    },
  };
}

export const POST = createDeliverListingHandler({
  sessionContext: authSessionContext,
  delivery: defaultDelivery(),
});
