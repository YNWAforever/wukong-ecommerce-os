import { getDatabase } from "../../../../../../lib/intake-runtime";
import { ApiError, withRouteErrors } from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import { canonicalJson } from "../../../../../../lib/studio/output-service";
import {
  STUDIO_EXPORTABLE_STATUSES,
  STUDIO_EXPORT_SCHEMA_VERSION,
  buildExportReceipt,
  exportDigestQuerySchema,
  sha256Hex,
} from "../../../../../../lib/studio/export-receipt";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../../../lib/studio/turn-service";

/**
 * `GET /api/studio/outputs/[id]/receipt?digest=<contentDigest>` (B3 follow-up).
 *
 * Returns the server-computed export receipt for a saved/signed-off artifact
 * without returning the artifact payload itself. It runs the exact same gates
 * as `GET /api/studio/outputs/[id]/export`:
 *
 *  - the Studio flag, session/workspace scope and a foreign/unknown id are
 *    resolved by `getOutput` (403/404 as usual);
 *  - only a `saved`/`signed_off` artifact is receiptable (`409 output_not_saved`);
 *  - the caller's preview digest must equal the current version digest, and the
 *    persisted payload is re-hashed, both `409 output_changed`;
 *  - a missing/invalid digest is a 400; a malformed signing configuration is a
 *    500 `export_signing_misconfigured` rather than a silent `signed: false`.
 *
 * The signing key itself is never returned. `receipt` is `null` and
 * `signed:false` only when no key is configured at all (`keyConfigured:false`).
 */

export function createStudioOutputReceiptHandler(deps: StudioRouteDeps) {
  const service = () => createStudioService(studioServiceDeps(deps));
  return async function readReceipt(
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) {
    return withRouteErrors(async () => {
      const { id } = await context.params;
      const url = new URL(request.url);
      const digest = exportDigestQuerySchema.safeParse(
        Object.fromEntries(url.searchParams),
      );
      if (!digest.success)
        throw new ApiError(
          400,
          "invalid_request",
          "A preview digest is required.",
        );

      // getOutput applies the Studio gate, workspace scoping and a foreign-id
      // 404 before anything below reads a payload.
      const bundle = await service().getOutput(id);
      if (!STUDIO_EXPORTABLE_STATUSES.has(bundle.output.status))
        throw new ApiError(
          409,
          "output_not_saved",
          "Save the artifact before reading its export receipt.",
        );

      const latest = bundle.versions.reduce((current, version) =>
        version.revision > current.revision ? version : current,
      );
      if (latest.contentDigest !== digest.data.digest)
        throw new ApiError(
          409,
          "output_changed",
          "The artifact changed since this preview.",
        );
      if (sha256Hex(canonicalJson(latest.payload)) !== latest.contentDigest)
        throw new ApiError(
          409,
          "output_changed",
          "The persisted artifact content no longer matches its digest.",
        );

      const state = buildExportReceipt({
        env: deps.env ?? process.env,
        schemaVersion: STUDIO_EXPORT_SCHEMA_VERSION,
        payloadSha256: latest.contentDigest,
        outputId: bundle.output.outputId,
        revision: latest.revision,
        asOf: latest.asOf,
        signedAt: deps.now?.() ?? new Date(),
      });

      return Response.json(
        {
          schemaVersion: STUDIO_EXPORT_SCHEMA_VERSION,
          payloadSha256: latest.contentDigest,
          outputId: bundle.output.outputId,
          revision: latest.revision,
          asOf: latest.asOf,
          keyConfigured: state.keyConfigured,
          signed: state.signed,
          receipt: state.receipt,
        },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    });
  };
}

const handler = createStudioOutputReceiptHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handler;
