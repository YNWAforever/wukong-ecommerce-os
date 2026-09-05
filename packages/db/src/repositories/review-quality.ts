import { sql } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";

/** Scalar approval aggregate is complete; edit hydration is capped and fails unavailable. */
export async function readReviewQualityEvidence(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
  start: string,
  end: string,
) {
  scope.assertOpen();
  const rows = await transaction.execute(sql`
 with cohort as materialized (
  select id,listing_id,created_at from listing_versions where workspace_id=${workspaceId} and created_at>=${start}::timestamptz and created_at<${end}::timestamptz
 ), approvals as materialized (
  select a.id,a.created_at,v.id version_id,v.created_at version_created_at
  from audit_events a left join cohort v on v.id::text=a.metadata->>'versionId' and v.listing_id::text=a.entity_id
  where a.workspace_id=${workspaceId} and a.action='listing.approved' and a.created_at>=${start}::timestamptz and a.created_at<${end}::timestamptz
 ), qualified as (
  select version_id,min(created_at) approved_at,min(version_created_at) version_created_at,count(*) n from approvals
  where version_id is not null and created_at>=version_created_at group by version_id
 ), edits as materialized (
  select * from review_events where workspace_id=${workspaceId} and action='listing.edited' and created_at>=${start}::timestamptz and created_at<${end}::timestamptz order by created_at,id limit 1001
 ), pairs as (
  select e.id,e.listing_id as "listingId",e.metadata->>'baseVersionId' as "baseVersionId",e.metadata->>'versionId' as "versionId",e.actor_id as "actorId",e.created_at as "createdAt",
   b.sequence as "baseSequence",v.sequence,v.created_by as "createdBy",v.pipeline_idempotency_key as "pipelineKey",b.created_at as "baseCreatedAt",v.created_at as "versionCreatedAt",
   case when octet_length(b.content::text)<=16384 then b.content else null end as "baseContent",
   case when octet_length(v.content::text)<=16384 then v.content else null end as content
  from edits e
  left join listing_versions b on b.workspace_id=${workspaceId} and b.listing_id=e.listing_id and b.id::text=e.metadata->>'baseVersionId'
  left join listing_versions v on v.workspace_id=${workspaceId} and v.listing_id=e.listing_id and v.id::text=e.metadata->>'versionId'
 )
 select (select count(*)::int from cohort) versions,
  (select count(*)::int from qualified) approved,
  (select coalesce(sum(extract(epoch from (approved_at-version_created_at))*1000),0)::float8 from qualified) as "elapsedMs",
  (select coalesce(sum(n-1),0)::int from qualified) as "duplicateApprovals",
  (select count(*)::int from approvals where version_id is null or created_at<version_created_at) as "invalidApprovals",
  (select coalesce(jsonb_agg(to_jsonb(pairs)),'[]') from pairs) edits
 `);
  const row = rows[0]!;
  return {
    versions: Number(row.versions),
    approved: Number(row.approved),
    elapsedMs: Number(row.elapsedMs),
    duplicateApprovals: Number(row.duplicateApprovals),
    invalidApprovals: Number(row.invalidApprovals),
    edits: row.edits as unknown[],
  };
}
