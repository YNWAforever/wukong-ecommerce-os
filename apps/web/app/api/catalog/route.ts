import { loadSourceReadinessBatch } from "../../../lib/source-readiness";
import { resultCapabilities } from "../../../lib/export-reconciliation";
import { decodeReadCursor, encodeReadCursor } from "../../../lib/read-cursor";
import { z } from "zod";

import {
  ListingDataError,
  listingInputDigest,
  type Database,
} from "@wukong/db";

import { getDatabase } from "../../../lib/intake-runtime";
import { createCatalogPerformance } from "../../../lib/catalog-performance";
import {
  atRouteStage,
  createRouteDiagnostics,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import { readIsolatedListing } from "../../../lib/listing-read-resilience";
import { authSessionContext } from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(21474836).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(1024).optional(),
  q: z.string().trim().optional(),
  work: z.enum(["all", "mine", "unassigned", "review"]).default("all"),
  importId: z.uuid().optional(),
  filter: z
    .enum([
      "workbook",
      "website",
      "all",
      "drafts",
      "bound",
      "attention",
      "review",
      "unlinked",
      "published",
    ])
    .default("all"),
});

type CatalogRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
};

export function createCatalogHandler(deps: CatalogRouteDeps) {
  return async function catalog(request: Request): Promise<Response> {
    const diagnostics = createRouteDiagnostics();
    const performance = createCatalogPerformance();
    return withRouteErrors(async () => {
      const context = await performance.measure("session", () =>
        atRouteStage("session", () =>
          requireSessionContext(deps.sessionContext),
        ),
      );
      const url = new URL(request.url);
      const query = querySchema.parse(Object.fromEntries(url.searchParams));
      const cursorScope = {
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        role: context.role,
        view: "catalog",
        pageSize: query.pageSize,
        q: (query.q ?? "").trim().toLocaleLowerCase(),
        filter: query.filter,
        work: query.work,
        importId: query.importId ?? null,
      };
      const { cursor: token, ...pageQuery } = query;
      const cursor = decodeReadCursor(token, cursorScope);

      const result = await performance.measure("workspace", () =>
        deps
          .getDatabase()
          .forWorkspace(context.workspaceId, async (repositories) => {
            const page = await performance.measure("catalog", () =>
              atRouteStage("listing", () =>
                repositories.reads.catalogPage({
                  ...pageQuery,
                  ...(cursor ? { cursor } : {}),
                  actorId: context.actorId,
                }),
              ),
            );
            const products = await performance.measure("products", () =>
              atRouteStage("sources", () =>
                repositories.platformProducts.getByIdsIsolated(
                  page.items
                    .filter((item) => item.sourceType === "platform")
                    .map((item) => item.id),
                ),
              ),
            );
            const byId = new Map(
              products.map((product) => [product.id, product]),
            );
            const reader = await performance.measure("sources", () =>
              atRouteStage("sources", () =>
                loadSourceReadinessBatch(
                  repositories,
                  context.workspaceId,
                  page.items.flatMap((item) =>
                    (item.sourceType === "platform" ||
                      item.sourceType === "draft") &&
                    item.listingId
                      ? [item.listingId]
                      : [],
                  ),
                  products.flatMap((item) =>
                    item.product ? [item.product] : [],
                  ),
                ),
              ),
            );
            const items = await performance.measure("rows", () =>
              Promise.all(
                page.items.map(async (item) => {
                  if (
                    item.sourceType !== "platform" &&
                    item.sourceType !== "draft"
                  )
                    return item;
                  const readiness = await readIsolatedListing(
                    diagnostics,
                    "sources",
                    () => {
                      const hydrated = byId.get(item.id);
                      if (
                        item.sourceType === "platform" &&
                        (!hydrated || hydrated.error)
                      )
                        throw (
                          hydrated?.error ??
                          new ListingDataError("invalid_platform_product")
                        );
                      return reader.read(
                        item.listingId,
                        item.sourceType === "platform"
                          ? (hydrated?.product ?? null)
                          : null,
                      );
                    },
                  );
                  return readiness.state === "ready"
                    ? {
                        ...item,
                        readState: "ready" as const,
                        sourceReadiness: readiness.value,
                      }
                    : {
                        ...item,
                        readState: "blocked" as const,
                        sourceReadiness: null,
                        supportRequestId: readiness.failure.requestId,
                      };
                }),
              ),
            );
            return { ...page, items };
          }),
      );

      return performance.attach(
        await performance.measure("serialize", async () =>
          jsonResponse(200, {
            capabilities: {
              ...resultCapabilities(context.role),
              canMaintainProducts: context.role !== "viewer",
            },
            selectionScope: listingInputDigest({
              workspaceId: context.workspaceId,
              actorId: context.actorId,
              role: context.role,
            }),
            ...result,
            nextCursor: encodeReadCursor(result.nextCursor, cursorScope),
            previousCursor: encodeReadCursor(
              result.previousCursor,
              cursorScope,
            ),
            scope: "workspace",
            page: query.page,
            pageSize: query.pageSize,
          }),
        ),
      );
    }, diagnostics);
  };
}

export const GET = createCatalogHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
