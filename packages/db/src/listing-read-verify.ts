import type { WineStage } from "@wukong/core";

import { forWorkspace, type Database } from "./client.js";

type ReadIssue = { listingId: string; call: string; code: string };

export type ListingReadReport = {
  checked: number;
  failures: ReadIssue[];
  // Invalid stored content: the detail route shows these as a blocked read,
  // not a 500, so they are reported but never fail the check.
  isolated: ReadIssue[];
};

const ISOLATED_CODES = new Set(["ListingDataError"]);

const WINE_STAGES: WineStage[] = [
  "extraction",
  "search_basic",
  "verification",
  "search_deep",
  "verification_deep",
  "generation",
  "quality_check",
  "commit_candidate",
];

// Drizzle wraps the driver error; the SQLSTATE sits on `cause`. Same walk as
// the web route diagnostics (apps/web/lib/route-support.ts diagnosticCode).
function errorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== "object" || current === null) break;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Runs the reads the listing detail route makes, each in its own workspace
 * transaction so one failure cannot poison the next. A null result is healthy;
 * only a thrown error is a failure. Reports IDs and codes, never content.
 */
export async function verifyListingReads(
  database: Database,
  listings: { workspaceId: string; listingId: string }[],
): Promise<ListingReadReport> {
  const failures: ReadIssue[] = [];
  const isolated: ReadIssue[] = [];
  for (const { workspaceId, listingId } of listings) {
    const read = async <T>(
      call: string,
      work: Parameters<typeof forWorkspace<T>>[2],
    ): Promise<T | undefined> => {
      try {
        return await forWorkspace(database, workspaceId, work);
      } catch (error) {
        const code = errorCode(error);
        (ISOLATED_CODES.has(code) ? isolated : failures).push({
          listingId,
          call,
          code,
        });
        return undefined;
      }
    };
    await read("getReviewSnapshot", (repos) =>
      repos.listings.getReviewSnapshot(listingId),
    );
    await read("getById", (repos) => repos.listings.getById(listingId));
    await read("listingInputs.getCurrent", async (repos) =>
      repos.listingInputs?.getCurrent(listingId),
    );
    const run = await read("getCurrentOperation", async (repos) =>
      repos.pipelineRuns.getCurrentOperation?.(listingId),
    );
    await read("getLatestState", async (repos) =>
      repos.pipelineRuns.getLatestState?.(listingId),
    );
    if (run) {
      await read("wineEnrichment.readUsage", (repos) =>
        repos.wineEnrichment.readUsage(run.id),
      );
      for (const stage of WINE_STAGES)
        await read(`wineEnrichment.readStage:${stage}`, (repos) =>
          repos.wineEnrichment.readStage(run.id, stage),
        );
    }
  }
  return { checked: listings.length, failures, isolated };
}
