import { readSourceReadiness } from "../../../lib/source-readiness";
import { resultCapabilities } from "../../../lib/export-reconciliation";
import { z } from "zod";

import {
  ListingDataError,
  listingInputDigest,
  type Database,
} from "@wukong/db";

import { getDatabase } from "../../../lib/intake-runtime";
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
    return withRouteErrors(async () => {
      const context = await atRouteStage("session", () =>
        requireSessionContext(deps.sessionContext),
      );
      const url = new URL(request.url);
      const query = querySchema.parse(Object.fromEntries(url.searchParams));

      const result = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const page = await atRouteStage("listing", () =>
            repositories.reads.catalogPage({
              ...query,
              actorId: context.actorId,
            }),
          );
          const products = await atRouteStage("sources", () =>
            repositories.platformProducts.getByIdsIsolated(
              page.items
                .filter((item) => item.sourceType === "platform")
                .map((item) => item.id),
            ),
          );
          const byId = new Map(
            products.map((product) => [product.id, product]),
          );
          const items = await Promise.all(
            page.items.map(async (item) => {
              if (item.sourceType !== "platform" && item.sourceType !== "draft")
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
                  return readSourceReadiness(
                    repositories,
                    context.workspaceId,
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
          );
          return { ...page, items };
        });

      return jsonResponse(200, {
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
        scope: "workspace",
        page: query.page,
        pageSize: query.pageSize,
      });
    }, diagnostics);
  };
}

export const GET = createCatalogHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
