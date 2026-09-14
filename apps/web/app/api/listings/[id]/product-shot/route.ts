import { z } from "zod";
import type { Database } from "@wukong/db";
import type { AssetStore } from "@wukong/assets";
import { getDatabase, getAssetStore } from "../../../../../lib/intake-runtime";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";
import {
  ApiError,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import {
  readProductShot,
  prepareProductShot,
  approveProductShot,
} from "../../../../../lib/product-shot-service";
// This route genuinely decodes an uploaded image, so it opts into `sharp`
// explicitly. `next.config.mjs` traces libvips for the routes that do.
import { validateProductShotSource } from "@wukong/assets/product-shot-render";
import {
  attachProductShotSourceFromProcess,
  type ProductShotAttachInput,
  requestProductShotFromProcess,
  type ProductShotRequestInput,
  type ProductShotRequestResult,
} from "../../../../../lib/product-shot-request";
export const runtime = "nodejs";
export type ProductShotRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => Pick<Database, "forWorkspace">;
  getAssetStore: () => AssetStore;
  requestShot?: (
    input: ProductShotRequestInput,
  ) => Promise<ProductShotRequestResult>;
  attachShot?: (
    input: ProductShotAttachInput,
  ) => Promise<ProductShotRequestResult>;
};
const sourceBody = z
  .object({
    sourceAssetId: z.uuid().optional(),
    expectedVersionId: z.uuid(),
    explicitFreshAttempt: z.boolean().default(false),
  })
  .strict();
const attachBody = z
  .object({
    sourceAssetId: z.uuid(),
    expectedVersionId: z.uuid(),
  })
  .strict();
const prepareBody = z
  .object({ attemptId: z.uuid(), expectedVersionId: z.uuid() })
  .strict();
const approvalBody = prepareBody
  .extend({ candidateDigest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export function createProductShotHandler(
  deps: ProductShotRouteDeps,
  action: "read" | "request" | "attach" | "prepare" | "approve",
) {
  return async (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (
        action !== "read" &&
        !(
          action === "approve"
            ? ["reviewer", "admin", "owner"]
            : ["operator", "reviewer", "admin", "owner"]
        ).includes(session.role)
      )
        throw new ApiError(
          403,
          "insufficient_role",
          "This action requires additional workspace permissions.",
        );
      const { id } = await context.params;
      if (!z.uuid().safeParse(id).success)
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const scope = {
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        listingId: id,
      };
      const db = deps.getDatabase();
      const reply = (value: unknown) =>
        Response.json(value, {
          headers: { "cache-control": "private, no-store" },
        });
      try {
        if (action === "request") {
          const body = sourceBody.parse(await request.json());
          const found = await db.forWorkspace(session.workspaceId, (r) =>
            r.listings.getReviewSnapshot(id),
          );
          if (!found)
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          return reply(
            await (
              deps.requestShot ??
              ((request: ProductShotRequestInput) =>
                requestProductShotFromProcess(
                  request,
                  validateProductShotSource,
                ))
            )({
              ...scope,
              ...body,
            }),
          );
        }
        if (action === "attach") {
          const body = attachBody.parse(await request.json());
          return reply(
            await (
              deps.attachShot ??
              ((request: ProductShotAttachInput) =>
                attachProductShotSourceFromProcess(
                  request,
                  validateProductShotSource,
                ))
            )({
              ...scope,
              ...body,
            }),
          );
        }
        if (action === "read") {
          const view = await readProductShot(scope, {
            forWorkspace: db.forWorkspace,
            assetStore: deps.getAssetStore(),
          });
          // Existing selections remain reviewable if provider dispatch is later disabled.
          return reply({
            ...view,
            allowedActions: ["operator", "reviewer", "admin", "owner"].includes(
              session.role,
            )
              ? view.allowedActions.filter(
                  (action) =>
                    action !== "approve" ||
                    ["reviewer", "admin", "owner"].includes(session.role),
                )
              : [],
            enabled:
              Boolean(view.attemptId) ||
              ["fake", "photoroom"].includes(
                process.env.PRODUCT_SHOT_PROVIDER ?? "",
              ),
          });
        }
        const body = (action === "prepare" ? prepareBody : approvalBody).parse(
          await request.json(),
        );
        const service = {
          forWorkspace: db.forWorkspace,
          assetStore: deps.getAssetStore(),
        };
        if (action === "prepare")
          return reply(
            await prepareProductShot({ ...scope, ...body }, service),
          );
        await approveProductShot(
          { ...scope, ...approvalBody.parse(body) },
          service,
        );
        return reply({ state: "approved" });
      } catch (error) {
        if (error instanceof Error && error.name === "ProductShotConflict")
          throw new ApiError(
            409,
            "image_review_conflict",
            "Reload the image review before trying again.",
          );
        if (
          error instanceof Error &&
          ["source_not_found", "input_too_large", "invalid_image"].includes(
            error.message,
          )
        )
          throw new ApiError(
            422,
            error.message,
            "Choose a valid image attached to this listing.",
          );
        throw error;
      }
    });
}
export const productShotRouteDeps: ProductShotRouteDeps = {
  sessionContext: authSessionContext,
  getDatabase,
  getAssetStore,
};
export const GET = createProductShotHandler(productShotRouteDeps, "read");
export const POST = createProductShotHandler(productShotRouteDeps, "request");
