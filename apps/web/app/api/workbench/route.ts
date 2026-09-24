import type { Database } from "@wukong/db";
import { z } from "zod";

import { resultCapabilities } from "../../../lib/export-reconciliation";
import { getDatabase } from "../../../lib/intake-runtime";
import {
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";

const querySchema = z.object({
  state: z
    .enum(["attention", "progress", "completed", "unclassified"])
    .default("attention"),
  kind: z
    .enum(["listing", "export", "website_scan", "workbook_import"])
    .optional(),
  page: z.coerce.number().int().min(1).max(21474836).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

type WorkbenchRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
};

export function createWorkbenchHandler(deps: WorkbenchRouteDeps) {
  return async function workbench(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const query = querySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      const page = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, (repositories) =>
          repositories.workbench.page(query),
        );
      const existing = resultCapabilities(context.role);

      return Response.json(
        {
          ...page,
          capabilities: {
            canImport: requireWorkspaceRole("operator", context.role),
            canReview: requireWorkspaceRole("reviewer", context.role),
            canRecordImportResult: existing.canRecordImportResult,
          },
        },
        { status: 200, headers: { "Cache-Control": "private, no-store" } },
      );
    });
  };
}

export const GET = createWorkbenchHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
