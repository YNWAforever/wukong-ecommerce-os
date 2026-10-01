import { sql } from "drizzle-orm";
import type { BulkFormContentGaps } from "@wukong/shopline";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import {
  createMaintenanceContentReader,
  type MaintenanceContent,
} from "./maintenance-content.js";

export const QUALITY_ASSESSMENT_VERSION = "opak-current-content-v1" as const;
const GAP_KEYS = [
  "untranslatedName",
  "untranslatedSeoTitle",
  "seoTitleMirrorsName",
  "seoDescriptionMirrorsSeoTitle",
  "keywordsMirrorName",
  "summaryMissing",
] as const;
const COUNT_KEYS = [
  "totalListings",
  "totalAssessed",
  "cleanCount",
  "hasGapsCount",
  "noActiveVersion",
  "unassessableActiveVersion",
  "missingCurrentContent",
  "invalidCurrentContent",
  ...GAP_KEYS,
] as const;
type CountKey = (typeof COUNT_KEYS)[number];
type Contribution = Record<CountKey, number>;
const empty = (): Contribution =>
  Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as Contribution;
export type QualityContentAssessor = (
  input: Pick<MaintenanceContent, "content" | "assessmentState">,
) => {
  gaps: BulkFormContentGaps | null;
  assessmentState: MaintenanceContent["assessmentState"];
};
/** Only this explicit safe content category is recoverable per item. SQL/auth/programming faults propagate. */
export class QualityContentAssessmentError extends Error {
  readonly category = "content_assessment_failed";
  constructor() {
    super("content assessment failed");
    this.name = "QualityContentAssessmentError";
  }
}
export type QualityProjectionSummary = {
  assessmentVersion: typeof QUALITY_ASSESSMENT_VERSION;
  totalListings: number;
  totalAssessed: number;
  cleanCount: number;
  hasGapsCount: number;
  noActiveVersion: number;
  unassessableActiveVersion: number;
  missingCurrentContent: number;
  invalidCurrentContent: number;
  gapCounts: Record<keyof BulkFormContentGaps, number>;
  projection: {
    state: "ready" | "pending" | "failed";
    asOf: string | null;
    stale: boolean;
    pendingCount: number;
    failedCount: number;
  };
};
export type QualityProjectionRepository = {
  read(): Promise<QualityProjectionSummary>;
  reconcile(
    assess: QualityContentAssessor,
    options?: { limit?: number },
  ): Promise<QualityProjectionSummary>;
  recordCostSnapshot(input: {
    knownCostUsd: number;
    unknownCostRunCount: number;
    asOf: string;
  }): Promise<void>;
};
function parseContribution(value: unknown): Contribution {
  if (!value || typeof value !== "object")
    throw Error("quality projection contribution invariant");
  const result = empty();
  for (const key of COUNT_KEYS) {
    const count = (value as Record<string, unknown>)[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0)
      throw Error("quality projection count invariant");
    result[key] = count as number;
  }
  return result;
}
function contribution(
  item: MaintenanceContent,
  assess: QualityContentAssessor,
): Contribution {
  const result = empty();
  result.totalListings = 1;
  result.noActiveVersion = item.fence.activeVersionId ? 0 : 1;
  const assessment = assess(item);
  if (assessment.assessmentState === "missing")
    result.missingCurrentContent = 1;
  if (assessment.assessmentState === "invalid") {
    result.invalidCurrentContent = 1;
    result.unassessableActiveVersion = item.fence.activeVersionId ? 1 : 0;
  }
  if (assessment.gaps) {
    if (assessment.assessmentState !== "assessed")
      throw Error("quality assessor state invariant");
    result.totalAssessed = 1;
    for (const key of GAP_KEYS) {
      if (typeof assessment.gaps[key] !== "boolean")
        throw Error("quality assessor gap invariant");
      result[key] = Number(assessment.gaps[key]);
    }
    result.hasGapsCount = GAP_KEYS.some((key) => Boolean(result[key])) ? 1 : 0;
    result.cleanCount = 1 - result.hasGapsCount;
  } else if (assessment.assessmentState === "assessed")
    throw Error("quality assessor gaps missing");
  return result;
}
export function createQualityProjectionRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): QualityProjectionRepository {
  const reader = createMaintenanceContentReader(tx, workspaceId, scope);
  async function read(): Promise<QualityProjectionSummary> {
    scope.assertOpen();
    // Saved base and ALL dirty corrections share this statement snapshot. No listing content is scanned.
    const counts = sql.join(
      COUNT_KEYS.flatMap((key) => [
        sql`${key}::text`,
        sql`(s.counts->>${key})::bigint-coalesce(c.${sql.identifier(key)},0)`,
      ]),
      sql`, `,
    );
    const corrections = sql.join(
      COUNT_KEYS.map(
        (key) =>
          sql`coalesce(sum((contribution->>${key})::bigint),0) as ${sql.identifier(key)}`,
      ),
      sql`, `,
    );
    const validContribution = sql.join(
      COUNT_KEYS.map(
        (key) =>
          sql`(jsonb_typeof(contribution->${key})='number' and (contribution->>${key})::numeric>=0 and mod((contribution->>${key})::numeric,1)=0)`,
      ),
      sql` and `,
    );
    const [row] = await tx.execute(sql`
      with dirty as (select contribution,state from listing_quality_assessments where workspace_id=${workspaceId} and assessment_version=${QUALITY_ASSESSMENT_VERSION} and (state<>'ready' or requested_generation<>applied_generation)),
      corrections as (select ${corrections}, count(*) filter(where state='pending')::int pending_count, count(*) filter(where state='failed')::int failed_count, count(*) filter(where state='ready')::int inconsistent_count, count(*) filter(where (${validContribution}) IS NOT TRUE)::int invalid_contribution_count from dirty),
      cohort as (select count(*)::int total, count(*) filter(where d.active_version_id is null)::int no_active,
        count(*) filter(where q.listing_id is null)::int uncovered
        from listing_drafts d left join listing_quality_assessments q on q.workspace_id=${workspaceId} and q.assessment_version=${QUALITY_ASSESSMENT_VERSION} and q.listing_id=d.id and q.live_listing_id=d.id
        where d.workspace_id=${workspaceId})
      select s.initialized,s.as_of,jsonb_build_object(${counts}) counts,c.pending_count,c.failed_count,c.inconsistent_count,c.invalid_contribution_count,h.total,h.no_active,h.uncovered
      from workspace_quality_summaries s cross join corrections c cross join cohort h
      where s.workspace_id=${workspaceId} and s.assessment_version=${QUALITY_ASSESSMENT_VERSION}
    `);
    if (!row) throw Error("quality projection source coverage invariant");
    if (Number(row.invalid_contribution_count) !== 0)
      throw Error("quality projection contribution invariant");
    if (Number(row.inconsistent_count) !== 0)
      throw Error("quality projection ready generation invariant");
    if (!row?.initialized || Number(row.uncovered) !== 0)
      throw Error("quality projection source coverage invariant");
    const values = parseContribution(row.counts);
    const pendingCount = Number(row.pending_count),
      failedCount = Number(row.failed_count);
    const stale = pendingCount + failedCount > 0;
    return {
      assessmentVersion: QUALITY_ASSESSMENT_VERSION,
      totalListings: Number(row.total),
      noActiveVersion: Number(row.no_active),
      totalAssessed: values.totalAssessed,
      cleanCount: values.cleanCount,
      hasGapsCount: values.hasGapsCount,
      unassessableActiveVersion: values.unassessableActiveVersion,
      missingCurrentContent: values.missingCurrentContent,
      invalidCurrentContent: values.invalidCurrentContent,
      gapCounts: Object.fromEntries(
        GAP_KEYS.map((key) => [key, values[key]]),
      ) as QualityProjectionSummary["gapCounts"],
      projection: {
        state: failedCount ? "failed" : pendingCount ? "pending" : "ready",
        asOf: row.as_of ? new Date(row.as_of as string).toISOString() : null,
        stale,
        pendingCount,
        failedCount,
      },
    };
  }
  return {
    read,
    async reconcile(assess, options) {
      scope.assertOpen();
      const limit = options?.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > 25)
        throw Error("quality reconciliation limit must be between1and25");
      // Claim rows before hydration. Never lock domain source rows while holding these claims.
      const claimed = await tx.execute(
        sql`select listing_id,live_listing_id,requested_generation,contribution from listing_quality_assessments where workspace_id=${workspaceId} and assessment_version=${QUALITY_ASSESSMENT_VERSION} and (state='pending' or (state='failed' and next_retry_at<=now())) order by listing_id limit ${limit} for update skip locked`,
      );
      const ids = claimed
        .filter((row) => row.live_listing_id)
        .map((row) => String(row.listing_id));
      const current = new Map(
        (await reader.getMaintenanceByIds(ids)).map((item) => [
          item.listingId,
          item,
        ]),
      );
      const delta = empty();
      let applied = 0;
      for (const row of claimed) {
        const id = String(row.listing_id);
        const item = current.get(id);
        if (row.live_listing_id && !item)
          throw Error("quality projection live source invariant");
        let next: Contribution;
        try {
          next = item ? contribution(item, assess) : empty();
        } catch (error) {
          if (!(error instanceof QualityContentAssessmentError)) throw error;
          await tx.execute(
            sql`update listing_quality_assessments set state='failed',error_category='content_assessment_failed',next_retry_at=now()+interval '30 seconds',updated_at=now() where workspace_id=${workspaceId} and assessment_version=${QUALITY_ASSESSMENT_VERSION} and listing_id=${id}::uuid and requested_generation=${row.requested_generation}::bigint`,
          );
          continue;
        }
        const old = parseContribution(row.contribution);
        for (const key of COUNT_KEYS) delta[key] += next[key] - old[key];
        const updated = await tx.execute(
          sql`update listing_quality_assessments set contribution=${JSON.stringify(next)}::jsonb,source_fence=${item ? JSON.stringify(item.fence) : null}::jsonb,applied_generation=requested_generation,state='ready',error_category=null,next_retry_at=null,updated_at=now() where workspace_id=${workspaceId} and assessment_version=${QUALITY_ASSESSMENT_VERSION} and listing_id=${id}::uuid and requested_generation=${row.requested_generation}::bigint returning listing_id`,
        );
        if (updated.length !== 1)
          throw Error("quality projection generation invariant");
        applied++;
      }
      if (applied) {
        const nextCounts = sql.join(
          COUNT_KEYS.flatMap((key) => [
            sql`${key}::text`,
            sql`(counts->>${key})::bigint+${delta[key]}::bigint`,
          ]),
          sql`, `,
        );
        const updated = await tx.execute(
          sql`update workspace_quality_summaries set counts=jsonb_build_object(${nextCounts}),as_of=now() where workspace_id=${workspaceId} and assessment_version=${QUALITY_ASSESSMENT_VERSION} and initialized returning workspace_id`,
        );
        if (updated.length !== 1)
          throw Error("quality projection summary invariant");
      }
      return read();
    },
    async recordCostSnapshot(input) {
      scope.assertOpen();
      if (
        !Number.isFinite(input.knownCostUsd) ||
        input.knownCostUsd < 0 ||
        !Number.isSafeInteger(input.unknownCostRunCount) ||
        input.unknownCostRunCount < 0 ||
        !Number.isFinite(Date.parse(input.asOf))
      )
        throw Error("quality cost snapshot invariant");
      const updated = await tx.execute(
        sql`update workspace_quality_summaries set known_cost_usd=${input.knownCostUsd.toFixed(6)}::numeric,unknown_cost_run_count=${input.unknownCostRunCount},cost_as_of=${input.asOf}::timestamptz where workspace_id=${workspaceId} and assessment_version=${QUALITY_ASSESSMENT_VERSION} and initialized returning workspace_id`,
      );
      if (updated.length !== 1)
        throw Error("quality projection cost summary invariant");
    },
  };
}
