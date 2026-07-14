import { z } from "zod";

import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import { deliverListing, type DeliveryResult, type DeliverInput } from "../../../../../lib/delivery-service";

const bodySchema = z.object({ method: z.enum(["csv", "shopline_api"]) }).strict();
type RouteContext = { params: Promise<{ id: string }> };

type DeliveryPort = { deliver(input: DeliverInput): Promise<DeliveryResult> };

export type DeliverListingRouteDeps = {
  sessionContext: typeof authSessionContext;
  delivery: DeliveryPort;
};

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
      return jsonResponse(202, { status: "queued", jobId: result.jobId, versionId: result.versionId });
    case "approval_required":
      throw new ApiError(409, "approval_required", "批准後才可匯出或上架。");
    case "blocking_flags":
      throw new ApiError(422, "blocking_flags", `仍有未解決的合規標記：${result.issues.join("、")}`);
    case "validation_error":
      throw new ApiError(422, "validation_error", "SHOPLINE 欄位驗證未通過。");
    case "disconnected":
      return jsonResponse(409, {
        code: "shopline_disconnected",
        message: "尚未連接 SHOPLINE，請先下載 CSV。",
        csvFallback: result.csvFallback,
      });
  }
}

export function createDeliverListingHandler(deps: DeliverListingRouteDeps) {
  return async function deliverListingHandler(request: Request, context: RouteContext): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "listing_not_found", "Listing not found.");
      const body = bodySchema.parse(await request.json());
      const result = await deps.delivery.deliver({ workspaceId: session.workspaceId, draftId: id, method: body.method });
      return responseFor(result, id);
    });
  };
}

function defaultDelivery(): DeliveryPort {
  return {
    async deliver(input) {
      const database = getDatabase();
      return database.forWorkspace(input.workspaceId, async (repositories) => deliverListing(input, {
        listings: repositories.listings,
        imageUrls: async () => [],
        audit: repositories.audit,
        publisher: { async enqueue() { throw new Error("SHOPLINE connection is not configured"); } },
        connection: null,
      }));
    },
  };
}

export const POST = createDeliverListingHandler({ sessionContext: authSessionContext, delivery: defaultDelivery() });

