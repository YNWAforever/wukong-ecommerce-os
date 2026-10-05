import { z } from "zod";
import { readWineProgress } from "../../../../lib/wine-progress";
import { emptyWorkingListing, workingBaselineForReview } from "@wukong/core";
import { usesProductShotWorkflow } from "../../../../lib/product-shot-workflow";
import { readSourceReadiness } from "../../../../lib/source-readiness";
import {
  readIsolatedListing,
  recordListingReadFailure,
  type ListingReadFailure,
} from "../../../../lib/listing-read-resilience";
import type { AssetStore } from "@wukong/assets";
import type { WorkspaceRepositories } from "@wukong/db";

import { getAssetStore, getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  atRouteStage,
  createRouteDiagnostics,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import { getListingActivity } from "../../../../lib/listing-activity-service";
import { readProcessingSummary } from "../../../../lib/listing-processing-summary";
import { listingApplicationJobId } from "../../../../lib/listing-queue-runtime";
import { authSessionContext } from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
type ListingRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: WorkspaceRepositories) => Promise<T>,
    ): Promise<T>;
  };
  getAssetStore: () => Pick<AssetStore, "createReadUrl">;
  connectionStatus?: (
    workspaceId: string,
  ) => Promise<"connected" | "disconnected" | "error">;
};

const PRODUCT_SHOT_PREVIEW_TTL_MS = 5 * 60 * 1000;

const roleRank: Record<string, number> = {
  viewer: 10,
  operator: 20,
  reviewer: 30,
  admin: 40,
  owner: 50,
};

function listingPermissions(role: string) {
  const rank = roleRank[role] ?? 0;
  return {
    canRecordImportResult: rank >= 20,
    canProcess: rank >= 20,
    canEdit: rank >= 20,
    canResolveFlags: rank >= 20,
    canApprove: rank >= 30,
    canDeliver: rank >= 30,
  };
}
export function createListingViewHandler(deps: ListingRouteDeps) {
  return async function listingViewHandler(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const diagnostics = createRouteDiagnostics();
    return withRouteErrors(async () => {
      const session = await atRouteStage("session", () =>
        requireSessionContext(deps.sessionContext),
      );
      const { id } = await context.params;
      if (!z.uuid().safeParse(id).success)
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const result = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const read = await readIsolatedListing(diagnostics, "listing", () =>
            repositories.listings.getReviewSnapshot(id),
          );
          if (read.state === "unavailable") {
            // Re-read identity under the same server workspace/RLS scope. No
            // corrupt content, inferred version or mutation capability escapes.
            const identity = await atRouteStage("listing", () =>
              repositories.listings.getById(id),
            );
            if (!identity)
              throw new ApiError(
                404,
                "listing_not_found",
                "Listing not found.",
              );
            return {
              listingId: id,
              workspaceId: session.workspaceId,
              status: identity.status,
              readState: "blocked" as const,
              readFailure: read.failure,
              activeVersion: null,
              permissions: Object.fromEntries(
                Object.keys(listingPermissions(session.role)).map((key) => [
                  key,
                  false,
                ]),
              ),
            };
          }
          const snapshot = read.value;
          if (!snapshot)
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          const versionId = snapshot.activeVersion?.id ?? null;
          const platformProductLink = await atRouteStage("sources", () =>
            repositories.platformProducts.getByListingId(id),
          );
          // Looked up by versionId, not by reconstructing the job's
          // idempotency key from current state: that key was "create" or
          // "update" depending on whether platformProductLink existed *at
          // enqueue time*, but a successful "create" job is exactly what
          // makes that link start existing. Re-deriving the key here from
          // the link's current existence flips it out from under the very
          // job whose result this is trying to read, and the lookup misses
          // right when the job finishes.
          const job = versionId
            ? await atRouteStage("review", () =>
                repositories.publishJobs.getByVersionId(versionId),
              )
            : null;
          const reviewConfirmation = versionId
            ? await atRouteStage("review", () =>
                repositories.reviewConfirmations.getByVersionId(versionId),
              )
            : null;
          let connection: "connected" | "disconnected" | "error";
          try {
            if (deps.connectionStatus) {
              connection = await deps.connectionStatus(session.workspaceId);
            } else {
              const configured =
                await repositories.shoplineConnections.getDefault();
              connection = configured ? "connected" : "disconnected";
            }
          } catch (error) {
            // An injected remote connection probe may be unavailable. A DB
            // query error aborts the workspace transaction and must propagate.
            if (!deps.connectionStatus)
              await atRouteStage("sources", async () => {
                throw error;
              });
            connection = "error";
          }

          const listingAssets = await atRouteStage("assets", () =>
            repositories.sourceAssets.listForListing(id),
          );
          const activity = await readIsolatedListing(
            diagnostics,
            "activity",
            () => getListingActivity(repositories, id),
          );
          const cutout = listingAssets.find(
            (asset: { kind: string; metadata: unknown }) =>
              asset.kind === "image/png" &&
              (asset.metadata as Record<string, unknown> | null)?.role ===
                "product_shot_cutout",
          );
          const productShotWorkflow = usesProductShotWorkflow({
            hasSelection: Boolean(
              await atRouteStage("assets", async () =>
                repositories.productShots?.currentForListing(id),
              ),
            ),
            hasLegacyCutout: Boolean(cutout),
          });
          let productShot: {
            previewUrl: string;
            brandBackgroundColor: string | null;
          } | null = null;
          const previewFailures: ListingReadFailure[] = [];
          // This boundary contains only signed-URL creation, never a DB query.
          // Missing previews leave immutable source identity/content intact.
          const preview = async (storageKey: string) => {
            try {
              return (
                await deps
                  .getAssetStore()
                  .createReadUrl(session.workspaceId, storageKey, {
                    expiresInMs: PRODUCT_SHOT_PREVIEW_TTL_MS,
                  })
              ).url;
            } catch {
              if (previewFailures.length === 0)
                previewFailures.push(
                  recordListingReadFailure(
                    diagnostics,
                    "assets",
                    "preview_unavailable",
                  ),
                );
              return null;
            }
          };
          if (cutout && !productShotWorkflow) {
            const profile = await atRouteStage("assets", () =>
              repositories.workspaces.requireProfile(),
            );
            const url = await preview(cutout.storageKey);
            productShot = url
              ? {
                  previewUrl: url,
                  brandBackgroundColor: profile.brandBackgroundColor,
                }
              : null;
          }

          // A run that ended in `needs_info` wrote no version, so without this
          // the page can only say that information is needed. The extraction
          // step is recorded with its full output before the missingFields
          // check, so what the model did read off the sources is already
          // durable -- this reads it back.
          const originalAssets = listingAssets.filter(
            (asset: any) =>
              !["product_shot_cutout", "product_shot_candidate"].includes(
                asset.metadata?.role,
              ),
          );
          const legacyWorkingContent = snapshot.activeVersion?.content ?? {
            ...emptyWorkingListing(),
            imageAssetIds: originalAssets
              .filter((asset: any) => asset.kind.startsWith("image/"))
              .map((asset: any) => asset.id),
          };
          const legacyWorkingInput = {
            revision: 0,
            baseVersionId: snapshot.activeVersion?.id ?? null,
            note: snapshot.listing.note ?? null,
            workingContent: legacyWorkingContent,
            fieldStates: {},
            sources: originalAssets.map((asset: any) => ({
              assetId: asset.id,
              role: asset.kind.startsWith("image/")
                ? "other_image"
                : "supplier_document",
              use: "analyse",
              hero: false,
              digest:
                asset.metadata?.sha256 ?? asset.metadata?.clientSha256 ?? "",
            })),
          };
          const workingInput =
            (await atRouteStage("listing", async () =>
              repositories.listingInputs?.getCurrent(id),
            )) ?? null;
          const currentRun =
            (await atRouteStage("listing", async () =>
              repositories.pipelineRuns.getCurrentOperation?.(id),
            )) ?? null;
          const processing = readProcessingSummary(
            await atRouteStage("listing", async () =>
              currentRun
                ? await repositories.pipelineRuns.getState(
                    currentRun.idempotencyKey,
                  )
                : await repositories.pipelineRuns.getLatestState?.(id),
            ),
          );
          const sources = await Promise.all(
            originalAssets.map(async (asset: any) => {
              return {
                assetId: asset.id,
                mimeType: asset.kind,
                name:
                  asset.metadata?.fileName ?? asset.storageKey.split("/").pop(),
                previewUrl: await preview(asset.storageKey),
              };
            }),
          );
          const sourceReadiness = await readIsolatedListing(
            diagnostics,
            "sources",
            () => readSourceReadiness(repositories, session.workspaceId, id),
          );

          return {
            readState: "ready" as const,
            sourceReadiness:
              sourceReadiness.state === "ready" ? sourceReadiness.value : null,
            listingId: id,
            workspaceId: session.workspaceId,
            status: snapshot.listing.status,
            inputRevision: snapshot.listing.inputRevision ?? 0,
            workingInput: workingInput
              ? {
                  ...workingInput,
                  ...workingBaselineForReview(
                    workingInput.workingContent,
                    workingInput.fieldStates,
                    snapshot.activeVersion?.content,
                  ),
                  baseVersionId: snapshot.activeVersion?.id ?? null,
                }
              : legacyWorkingInput,
            sources,
            currentRun: currentRun
              ? {
                  runId: currentRun.id,
                  state: currentRun.executionState,
                  attempt: currentRun.runAttempt,
                  retryOfRunId: currentRun.retryOfRunId,
                  acceptedAt: currentRun.acceptedAt,
                  errorCode: currentRun.errorCode,
                  inputRevision: currentRun.inputRevision,
                  baseVersionId: currentRun.baseVersionId,
                }
              : null,
            wineProgress: currentRun
              ? await readWineProgress(repositories, currentRun)
              : null,
            processing,
            activeVersion: snapshot.activeVersion,
            evidence: snapshot.evidence,
            flags: snapshot.flags,
            connection,
            productShot,
            productShotWorkflow,
            delivery: job
              ? {
                  status: job.status,
                  remoteProductId:
                    job.status === "published" ? job.remoteProductId : null,
                  error: job.status === "failed" ? job.error : null,
                }
              : null,
            queueStatus: job?.status ?? null,
            shoplineLink: platformProductLink
              ? {
                  remoteProductId: platformProductLink.remoteProductId,
                  origin: platformProductLink.origin,
                }
              : null,
            reviewConfirmation: reviewConfirmation
              ? {
                  revision: reviewConfirmation.revision,
                  fieldConfirmations: reviewConfirmation.fieldConfirmations,
                  negativeConfirmations:
                    reviewConfirmation.negativeConfirmations,
                }
              : null,
            sourceImportId: platformProductLink?.sourceImportId ?? null,
            contentDigest: platformProductLink?.contentDigest ?? null,
            importedSourceRow:
              platformProductLink?.origin === "import"
                ? platformProductLink.rawRow
                : null,
            reviewedRowDigest: snapshot.activeVersion?.sourceRowDigest ?? null,
            reviewedSourceImportId:
              snapshot.activeVersion?.sourceImportId ?? null,
            permissions: {
              ...listingPermissions(session.role),
              ...(sourceReadiness.state === "unavailable"
                ? {
                    canApprove: false,
                    canDeliver: false,
                  }
                : {}),
            },
            activity: activity.state === "ready" ? activity.value : [],
            sections: {
              activity:
                activity.state === "ready"
                  ? { state: "ready" }
                  : {
                      state: "unavailable",
                      ...activity.failure,
                    },
              previews: previewFailures[0]
                ? { state: "unavailable", ...previewFailures[0] }
                : { state: "ready" },
              sources:
                sourceReadiness.state === "ready"
                  ? { state: "ready" }
                  : {
                      state: "unavailable",
                      ...sourceReadiness.failure,
                    },
            },
            historicalImportResults: await atRouteStage("activity", () =>
              repositories.importResults.listHistoricalForListing(id),
            ),
          };
        });
      const response = jsonResponse(200, result);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }, diagnostics);
  };
}

export const GET = createListingViewHandler({
  sessionContext: authSessionContext,
  getDatabase,
  getAssetStore,
});
