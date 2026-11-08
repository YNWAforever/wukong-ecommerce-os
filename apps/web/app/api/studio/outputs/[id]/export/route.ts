import { createHash } from "node:crypto";
import { z } from "zod";

import { getDatabase } from "../../../../../../lib/intake-runtime";
import { ApiError, withRouteErrors } from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import { canonicalJson } from "../../../../../../lib/studio/output-service";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../../../lib/studio/turn-service";

/**
 * `GET /api/studio/outputs/[id]/export` (plan Task 11).
 *
 * Returns the canonical JSON export of a persisted Studio artifact. It is a
 * signed-by-digest packet: the caller passes the `digest` it previewed (the
 * version's `contentDigest` from `GET /api/studio/outputs/[id]`), and a mismatch
 * is a 409 rather than serving content that changed since the operator looked.
 *
 * Rules kept here:
 *  - only a `saved` or `signed_off` artifact is exportable;
 *  - the persisted payload is re-hashed and must match its stored digest;
 *  - the packet is `sorted-json-v1` with `payloadSha256` outside the payload;
 *  - a foreign or disabled-Studio id is the same 404 as any other artifact.
 *
 * No new dependency: JSON only, no PDF.
 */

const digestQuerySchema = z.object({
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .max(64),
});

const EXPORTABLE_STATUSES = new Set(["saved", "signed_off"]);
const SCHEMA_VERSION = "wukong-studio-output-export/v1";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createStudioOutputExportHandler(deps: StudioRouteDeps) {
  const service = () => createStudioService(studioServiceDeps(deps));
  return async function exportOutput(
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) {
    return withRouteErrors(async () => {
      const { id } = await context.params;
      const url = new URL(request.url);
      const digest = digestQuerySchema.safeParse(
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
      if (!EXPORTABLE_STATUSES.has(bundle.output.status))
        throw new ApiError(
          409,
          "output_not_saved",
          "Save the artifact before exporting it.",
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
      if (sha256(canonicalJson(latest.payload)) !== latest.contentDigest)
        throw new ApiError(
          409,
          "output_changed",
          "The persisted artifact content no longer matches its digest.",
        );

      const packet = {
        schemaVersion: SCHEMA_VERSION,
        canonicalization: "sorted-json-v1" as const,
        output: {
          outputId: bundle.output.outputId,
          kind: bundle.output.kind,
          title: bundle.output.title,
          status: bundle.output.status,
          revision: latest.revision,
          asOf: latest.asOf,
          scope: latest.scope,
        },
        payload: latest.payload,
        payloadSha256: latest.contentDigest,
      };
      const json = canonicalJson(packet);
      return new Response(json, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="studio-output-${bundle.output.outputId}-r${latest.revision}.json"`,
          "cache-control": "no-store",
        },
      });
    });
  };
}

const handler = createStudioOutputExportHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handler;
