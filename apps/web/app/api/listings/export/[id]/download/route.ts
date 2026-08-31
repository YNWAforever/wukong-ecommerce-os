import type { AssetStore } from "@wukong/assets";
import { BULK_FORM_XLSX_MIME_TYPE, createExportAssetKey } from "@wukong/assets";
import type { ExportAttempt } from "@wukong/db";

import {
  getAssetStore,
  getDatabase,
} from "../../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../../lib/session-context-port";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

// Identical to the export route's bespoke check (apps/web/app/api/listings/export/route.ts),
// itself a local copy of the deliver route's rule -- not exported from either, so this is a
// third copy of the exact same rule rather than a shared import.
function assertReviewer(role: string): void {
  if (!["reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Reviewer access is required.",
    );
  }
}

export type DownloadExportRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  getAssetStore: () => Pick<AssetStore, "readObject">;
};

export function createDownloadExportHandler(deps: DownloadExportRouteDeps) {
  return async function downloadExportHandler(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ApiError(
          404,
          "export_attempt_not_found",
          "Export attempt not found.",
        );
      }

      const attempt: ExportAttempt | null = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          repositories.exportAttempts.getById(id),
        );
      if (!attempt) {
        throw new ApiError(
          404,
          "export_attempt_not_found",
          "Export attempt not found.",
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await deps.getAssetStore().readObject(
          session.workspaceId,
          createExportAssetKey({
            workspaceId: session.workspaceId,
            exportAttemptId: attempt.id,
            fileName: `export-${attempt.id}.xlsx`,
          }),
        );
      } catch {
        // A committed `export_attempts` row can exist with its object not
        // yet written (or since failed) -- see the comment above the
        // asset-store write in apps/web/app/api/listings/export/route.ts.
        // That is a real, accepted state, not a bug, so it must not surface
        // as a bare 500 or be confused with "this export id never existed"
        // (the 404 above). Distinct code, distinct status.
        return jsonResponse(409, {
          code: "export_object_missing",
          message:
            "The export file has not been written yet or is unavailable; resubmit the export.",
        });
      }

      // `readObject`'s return type is `Uint8Array<ArrayBufferLike>` under
      // this repo's Node type augmentation, which `BodyInit` doesn't
      // structurally accept in TS 5.9's DOM lib (it wants
      // `Uint8Array<ArrayBuffer>`). Re-wrapping copies into a fresh,
      // concretely-typed buffer rather than casting past the checker --
      // identical to the deliver route's `bulk_form` branch
      // (apps/web/app/api/listings/[id]/deliver/route.ts).
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "content-type": BULK_FORM_XLSX_MIME_TYPE,
          "content-disposition": `attachment; filename="export-${attempt.id}-${attempt.specVersion}.xlsx"`,
        },
      });
    });
  };
}

export const GET = createDownloadExportHandler({
  sessionContext: authSessionContext,
  getDatabase,
  getAssetStore,
});
