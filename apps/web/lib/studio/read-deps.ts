import type { WorkspaceRepositories } from "@wukong/db";
import { bulkFormGaps } from "@wukong/shopline";

import { canonicalListingToGapsInput } from "../canonical-listing-gaps";
import type {
  CatalogSearchHit,
  ExportAttemptEvidence,
  JobEvidence,
  ListingEvidence,
  ListingGap,
  ListingRunStatus,
  QualityEvidence,
  SourceAssetEvidence,
  StudioReadDeps,
} from "./tools";

/**
 * Bind the deterministic Studio read surface to workspace-scoped repositories
 * (plan Task 6). Every read is re-resolved at request time through
 * `db.forWorkspace`, so a source removed since the last turn is simply absent
 * — never cached and never invented.
 *
 * This module owns the mapping decisions the tool registry and evidence engine
 * must not know about: which catalog rows have a linked listing, which
 * quality/gap records count, and how a missing active version is reported.
 */

/** `untranslatedName` -> `untranslated_name`, for stable gap codes. */
function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function openBlockingFlagCount(
  snapshot: NonNullable<
    Awaited<ReturnType<WorkspaceRepositories["listings"]["getReviewSnapshot"]>>
  >,
): number {
  return snapshot.flags.filter(
    (flag) => flag.status === "open" && flag.severity === "blocking",
  ).length;
}

/**
 * Map the workspace catalog page to linked-listing hits.
 *
 * Catalog rows with no linked listing (unlinked platform products, website
 * references, workbook rows) cannot answer a listing question, so they are
 * counted as skipped instead of being quoted as listings. `truncated` is true
 * only when the matched population is larger than the page actually read.
 */
export function buildStudioReadDeps(
  repos: WorkspaceRepositories,
): StudioReadDeps {
  return {
    async searchCatalog(input) {
      const query = input.query.trim();
      const page = await repos.reads.catalogPage({
        page: 1,
        pageSize: input.limit,
        filter: "all",
        ...(query ? { q: query } : {}),
      });
      const items: CatalogSearchHit[] = [];
      for (const item of page.items) {
        if (item.sourceType === "platform") {
          if (!item.listingId) continue;
          items.push({
            listingId: item.listingId,
            title: item.title,
            status: item.listingStatus ?? "unknown",
          });
          continue;
        }
        if (item.sourceType === "draft") {
          items.push({
            listingId: item.listingId,
            title: item.title,
            status: item.listingStatus,
          });
        }
      }
      return {
        items,
        truncated: page.totalMatching > page.items.length,
        unlinkedSkipped:
          page.summary.unlinked +
          page.summary.website +
          page.summary.workbook,
      };
    },

    async getListing(listingId): Promise<ListingEvidence | null> {
      const snapshot = await repos.listings.getReviewSnapshot(listingId);
      if (!snapshot) return null;
      const content = snapshot.activeVersion?.content ?? null;
      const title = content
        ? content.title["zh-Hant"] || content.title.en
        : "";
      return {
        listingId: snapshot.listing.id,
        status: snapshot.listing.status,
        title,
        activeVersion: snapshot.activeVersion
          ? {
              versionId: snapshot.activeVersion.id,
              sequence: snapshot.activeVersion.sequence,
            }
          : null,
        blockingFlagCount: openBlockingFlagCount(snapshot),
      };
    },

    async getListingCopy(listingId) {
      const snapshot = await repos.listings.getReviewSnapshot(listingId);
      if (!snapshot?.activeVersion) return null;
      const content = snapshot.activeVersion.content;
      return {
        listingId: snapshot.listing.id,
        activeVersionId: snapshot.activeVersion.id,
        activeVersionSequence: snapshot.activeVersion.sequence,
        title: { en: content.title.en, "zh-Hant": content.title["zh-Hant"] },
        description: {
          en: content.description.en,
          "zh-Hant": content.description["zh-Hant"],
        },
        seo: {
          title: {
            en: content.seo.title.en,
            "zh-Hant": content.seo.title["zh-Hant"],
          },
          description: {
            en: content.seo.description.en,
            "zh-Hant": content.seo.description["zh-Hant"],
          },
        },
      };
    },

    async getQuality(): Promise<QualityEvidence> {
      const summary = await repos.qualityProjection.read();
      return {
        assessmentVersion: summary.assessmentVersion,
        totalListings: summary.totalListings,
        totalAssessed: summary.totalAssessed,
        cleanCount: summary.cleanCount,
        hasGapsCount: summary.hasGapsCount,
        noActiveVersion: summary.noActiveVersion,
        unassessableActiveVersion: summary.unassessableActiveVersion,
        projectionState: summary.projection.state,
        asOf: summary.projection.asOf,
      };
    },

    async listJobs(limit): Promise<JobEvidence[]> {
      const runs = await repos.pipelineRuns.listForWorkspace(limit);
      return runs.map((run) => ({
        jobId: run.id,
        state: run.status,
        createdAt: run.createdAt.toISOString(),
      }));
    },

    async getListingGaps(
      listingId,
    ): Promise<{ gaps: ListingGap[] } | null> {
      const snapshot = await repos.listings.getReviewSnapshot(listingId);
      if (!snapshot) return null;
      // A missing active version is the strongest blocker: content checks
      // have nothing to assess, so they are not reported as clean.
      if (!snapshot.activeVersion)
        return { gaps: [{ code: "no_active_version", blocking: true }] };
      if (openBlockingFlagCount(snapshot) > 0)
        return { gaps: [{ code: "open_blocking_flag", blocking: true }] };
      // Same reviewed 6 checks the bulk-import path runs, applied to live
      // content; only real gaps are returned (false keys are omitted).
      const contentGaps = bulkFormGaps(
        canonicalListingToGapsInput(snapshot.activeVersion.content),
      );
      const gaps: ListingGap[] = [];
      for (const [key, present] of Object.entries(contentGaps)) {
        if (present === true) {
          gaps.push({ code: `content.${snakeCase(key)}`, blocking: false });
        }
      }
      return { gaps };
    },

    async getSourceAssets(assetIds): Promise<{
      items: SourceAssetEvidence[];
      missingAssetIds: string[];
    }> {
      if (assetIds.length === 0)
        return { items: [], missingAssetIds: [] };
      // Workspace-scoped repository: a foreign asset id cannot resolve here, so
      // it is reported as missing exactly like a deleted one.
      const rows = await repos.sourceAssets.getByIds([...assetIds]);
      const found = new Map(
        rows.map((row) => [
          row.id,
          {
            assetId: row.id,
            contentType: row.kind,
            listingId: row.listingId ?? null,
          } satisfies SourceAssetEvidence,
        ]),
      );
      return {
        items: assetIds.flatMap((id) => {
          const item = found.get(id);
          return item ? [item] : [];
        }),
        missingAssetIds: assetIds.filter((id) => !found.has(id)),
      };
    },

    async getListingRunStatus(
      listingId,
      runId,
    ): Promise<ListingRunStatus | null> {
      const operation = await repos.pipelineRuns.getOperation(runId);
      if (!operation || operation.listingId !== listingId) return null;
      return { state: operation.executionState };
    },

    async getListingCounts(): Promise<Record<string, number>> {
      return { ...(await repos.listings.countByStatus()) };
    },

    async getExportAttempts(limit): Promise<ExportAttemptEvidence[]> {
      const attempts = await repos.exportAttempts.listForWorkspace(
        Math.min(Math.max(limit, 1), 20),
      );
      return attempts.map((attempt) => ({
        attemptId: attempt.id,
        state:
          attempt.artifactStatus === "ready"
            ? "ready"
            : attempt.artifactStatus === "failed"
              ? "failed"
              : attempt.artifactStatus === "pending"
                ? "pending"
                : "recorded",
        rowCount: attempt.rowCount,
        createdAt: attempt.createdAt.toISOString(),
      }));
    },
  };
}
