import type { BulkFormSheet } from "@wukong/shopline";
import {
  readBulkFormSheet,
  readBulkFormSheetName,
} from "@wukong/shopline/bulk-form-xlsx";

import {
  createBulkFormImporter,
  type BulkFormImportInput,
  type BulkFormImportResult,
} from "../../../../lib/bulk-form-import";
import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

// readBulkFormSheet unzips with node:zlib, so this route cannot run on edge.
export const runtime = "nodejs";

/**
 * A catalog import creates a draft and an audit event per product inside one
 * transaction, so a full-size form is thousands of statements against a remote
 * Postgres. The default function timeout is far too short for that, and a
 * timeout mid-transaction rolls the whole import back.
 */
export const maxDuration = 300;

/** Opak's real export is ~180KB; this leaves generous headroom under Vercel's body limit. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_ECHOED_ISSUES = 100;

export type BulkFormImportRouteDeps = {
  sessionContext: SessionContextPort;
  readSheet(bytes: Uint8Array): BulkFormSheet;
  readSheetName(bytes: Uint8Array): string;
  importBulkForm(input: BulkFormImportInput): Promise<BulkFormImportResult>;
};

export function createBulkFormImportHandler(deps: BulkFormImportRouteDeps) {
  return async function importBulkForm(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength === 0) {
        throw new ApiError(
          400,
          "empty_upload",
          "Attach a SHOPLINE bulk update form.",
        );
      }
      if (body.byteLength > MAX_UPLOAD_BYTES) {
        throw new ApiError(
          413,
          "upload_too_large",
          "The bulk update form is too large.",
        );
      }

      let sheet: BulkFormSheet;
      try {
        sheet = deps.readSheet(body);
      } catch {
        // The reader's message can name internal container details; do not leak it.
        throw new ApiError(
          400,
          // Distinct from the importer's `bulk_form_unreadable` (422), which
          // means the workbook parsed but held no product rows. A client
          // branching on `code` must be able to tell "wrong file" from
          // "empty catalog".
          "upload_not_a_workbook",
          "The upload is not a readable xlsx workbook.",
        );
      }

      const url = new URL(request.url);
      const merchantAttestedExportAtRaw = url.searchParams.get(
        "merchantAttestedExportAt",
      );
      if (merchantAttestedExportAtRaw === null) {
        throw new ApiError(
          400,
          "merchant_attested_export_at_missing",
          "Provide the date this SHOPLINE export was generated.",
        );
      }
      const merchantAttestedExportAt = new Date(merchantAttestedExportAtRaw);
      if (Number.isNaN(merchantAttestedExportAt.getTime())) {
        throw new ApiError(
          400,
          "merchant_attested_export_at_invalid",
          "merchantAttestedExportAt must be a valid ISO 8601 date.",
        );
      }
      const filename = url.searchParams.get("filename");
      if (filename === null || filename.trim().length === 0) {
        throw new ApiError(
          400,
          "filename_missing",
          "Provide the original filename of the uploaded workbook.",
        );
      }

      const result = await deps.importBulkForm({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        sheet,
        rawBytes: body,
        merchantAttestedExportAt,
        filename,
        sheetName: deps.readSheetName(body),
      });

      console.info(
        JSON.stringify({
          event: "listing.bulk_form_imported",
          workspaceId: context.workspaceId,
          specVersion: result.specVersion,
          parsedRows: result.parsedRows,
          createdDrafts: result.createdDrafts,
          refreshedProducts: result.refreshedProducts,
          issueCount: result.issues.length,
        }),
      );

      return jsonResponse(201, {
        specVersion: result.specVersion,
        parsedRows: result.parsedRows,
        createdDrafts: result.createdDrafts,
        refreshedProducts: result.refreshedProducts,
        issues: result.issues.slice(0, MAX_ECHOED_ISSUES),
      });
    });
  };
}

export const POST = createBulkFormImportHandler({
  sessionContext: authSessionContext,
  readSheet: readBulkFormSheet,
  readSheetName: readBulkFormSheetName,
  importBulkForm: createBulkFormImporter({ getDatabase }),
});
