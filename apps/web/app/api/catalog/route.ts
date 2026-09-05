import { readSourceReadiness } from "../../../lib/source-readiness";
import { resultCapabilities } from "../../../lib/export-reconciliation";
import { z } from "zod";

import type { Database } from "@wukong/db";

import { getDatabase } from "../../../lib/intake-runtime";
import {
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import { authSessionContext } from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(21474836).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().optional(),
  filter: z
    .enum(["all", "attention", "review", "unlinked", "published"])
    .default("all"),
});

type CatalogRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
};

export function createCatalogHandler(deps: CatalogRouteDeps) {
  return async function catalog(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const url = new URL(request.url);
      const query = querySchema.parse(Object.fromEntries(url.searchParams));

      const result = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const page = await repositories.reads.catalogPage(query);
          const products = await repositories.platformProducts.getByIds(
            page.items.map((item) => item.id),
          );
          const byId = new Map(
            products.map((product) => [product.id, product]),
          );
          const items = await Promise.all(
            page.items.map(async (item) => ({
              ...item,
              sourceReadiness: await readSourceReadiness(
                repositories,
                context.workspaceId,
                item.listingId,
                byId.get(item.id) ?? null,
              ),
            })),
          );
          return { ...page, items };
        });

      return jsonResponse(200, {
        capabilities: resultCapabilities(context.role),
        ...result,
        scope: "workspace",
        page: query.page,
        pageSize: query.pageSize,
      });
    });
  };
}

export const GET = createCatalogHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
