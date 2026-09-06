import { sql } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import type { WorkbenchPage, WorkbenchQuery } from "./workbench-contract.js";

export type WorkbenchReadRepository = ReturnType<
  typeof createWorkbenchReadRepository
>;

/** A single MVCC snapshot classifies retained tasks, counts all history, and selects a page. */
export function createWorkbenchReadRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  return {
    async page(query: WorkbenchQuery): Promise<WorkbenchPage> {
      scope.assertOpen();
      const skip = (query.page - 1) * query.pageSize;
      if (
        !Number.isSafeInteger(query.page) ||
        query.page < 1 ||
        !Number.isInteger(query.pageSize) ||
        query.pageSize < 1 ||
        query.pageSize > 100 ||
        !Number.isSafeInteger(skip)
      )
        throw new Error("invalid workbench pagination");
      if (
        !["attention", "progress", "completed", "unclassified"].includes(
          query.state,
        ) ||
        (query.kind !== undefined &&
          !["listing", "export", "website_scan", "workbook_import"].includes(
            query.kind,
          ))
      )
        throw new Error("invalid workbench filter");
      const rows = await transaction.execute(sql`
        with listing_items as (
          select d.id, 'listing'::text kind,
            case d.status
              when 'failed' then 'failed' when 'publish_failed' then 'failed'
              when 'needs_info' then 'needs_info'
              when 'in_review' then 'review' when 'reopened' then 'review'
              when 'approved' then 'delivery'
              when 'received' then 'processing' when 'processing' then 'processing' when 'publishing' then 'processing'
              when 'published' then 'published' else 'unknown' end reason,
            coalesce(v.content->'title'->>'zh-Hant', v.content->'title'->>'en') title,
            null::text "sourceLabel", 1::int "productCount", d.updated_at "occurredAt", 'updated'::text "timestampKind"
          from listing_drafts d
          left join listing_versions v on v.id=d.active_version_id and v.workspace_id=${workspaceId} and v.listing_id=d.id
          where d.workspace_id=${workspaceId}
        ), scan_items as (
          select s.id, 'website_scan'::text kind,
            case s.state when 'failed' then 'failed'
              when 'queued' then 'processing' when 'running' then 'processing'
              when 'ready' then 'preview_ready' when 'partial' then 'preview_partial' else 'unknown' end reason,
            s.requested_url title, s.requested_url "sourceLabel",
            case when jsonb_typeof(s.checkpoint->'preview'->'products')='array'
              then jsonb_array_length(s.checkpoint->'preview'->'products') else null end "productCount",
            s.updated_at "occurredAt", 'updated'::text "timestampKind"
          from website_scans s where s.workspace_id=${workspaceId}
        ), workbook_items as (
          select w.id, 'workbook_import'::text kind, 'imported'::text reason,
            w.filename title, w.filename "sourceLabel", w.eligible_products "productCount",
            w.created_at "occurredAt", 'recorded'::text "timestampKind"
          from workbook_imports w where w.workspace_id=${workspaceId}
        ), export_members as materialized (
          select e.id, count(*)::int included,
            count(*) filter (where receipt.outcome='accepted')::int accepted,
            count(*) filter (where receipt.outcome='rejected')::int rejected,
            count(*) filter (where receipt.outcome is null or receipt.outcome not in ('accepted','rejected'))::int unreported,
            max(receipt.created_at) receipt_at
          from export_attempts e
          cross join lateral jsonb_array_elements(e.manifest) member
          left join lateral (
            select r.outcome,r.created_at from import_results r
            where r.workspace_id=${workspaceId} and r.workspace_id=e.workspace_id
              and r.mode='export' and r.export_attempt_id=e.id
              and r.listing_id::text=member->>'listingId'
              and r.version_id::text=member->>'versionId'
            order by r.revision desc limit 1
          ) receipt on true
          where e.workspace_id=${workspaceId} and member->>'outcome'='included'
          group by e.id
        ), export_items as (
          select e.id, 'export'::text kind,
            case when e.artifact_status='failed' then 'failed'
              when e.artifact_status='pending' then 'processing'
              when e.artifact_status='ready' and m.included>0 then
                case when m.rejected=0 and m.unreported=0 then 'result_reported' else 'result_needed' end
              else 'unknown' end reason,
            null::text title, null::text "sourceLabel", coalesce(m.included,0) "productCount",
            greatest(e.created_at,e.artifact_ready_at,m.receipt_at) "occurredAt",
            case when e.artifact_ready_at is not null or m.receipt_at is not null then 'updated' else 'recorded' end "timestampKind"
          from export_attempts e left join export_members m on m.id=e.id
          where e.workspace_id=${workspaceId}
        ), items as (
          select * from listing_items union all select * from scan_items
          union all select * from workbook_items union all select * from export_items
        ), filtered as materialized (
          select *, kind||':'||id::text key,
            case when reason in ('failed','needs_info','review','delivery','result_needed') then 'attention'
              when reason='processing' then 'progress'
              when reason in ('published','result_reported','preview_ready','preview_partial','imported') then 'completed'
              else 'unclassified' end state
          from items where (${query.kind ?? null}::text is null or kind=${query.kind ?? null})
        ), counts as (
          select jsonb_build_object(
            'attention',count(*) filter(where state='attention')::int,
            'progress',count(*) filter(where state='progress')::int,
            'completed',count(*) filter(where state='completed')::int,
            'unclassified',count(*) filter(where state='unclassified')::int) counts,
            count(*) filter(where state=${query.state})::int "totalMatching"
          from filtered
        ), selected as (
          select *, row_number() over(order by
            case when ${query.state}='attention' then
              case reason when 'failed' then 0 when 'needs_info' then 1 when 'review' then 2 else 3 end end,
            case when ${query.state}='attention' then "occurredAt" end asc,
            case when ${query.state}<>'attention' then "occurredAt" end desc, key asc) ordinal
          from filtered where state=${query.state}
          order by ordinal limit ${query.pageSize} offset ${skip}
        )
        select counts.counts, counts."totalMatching", statement_timestamp() as "observedAt",
          (select coalesce(jsonb_agg(to_jsonb(selected)-'ordinal' order by ordinal),'[]'::jsonb) from selected) items
        from counts
      `);
      const row = rows[0]!;
      return {
        items: row.items as WorkbenchPage["items"],
        counts: row.counts as WorkbenchPage["counts"],
        totalMatching: Number(row.totalMatching),
        observedAt: new Date(String(row.observedAt)).toISOString(),
        page: query.page,
        pageSize: query.pageSize,
      };
    },
  };
}
