import { sql } from "drizzle-orm";
import type { ListingStatus } from "@wukong/core";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";

export type PageQuery = { page: number; pageSize: number };
export type CatalogFilter =
  "all" | "attention" | "review" | "unlinked" | "published";
export type LedgerKind =
  "batch" | "publish_job" | "pipeline_run" | "export" | "import_result";
export type CatalogReadItem = {
  id: string;
  remoteProductId: string;
  origin: "import" | "created";
  sku: string | null;
  listingId: string | null;
  specVersion: string | null;
  title: string;
  listingStatus: ListingStatus | null;
  openBlockingFlagCount: number | null;
  needsReview: boolean;
  needsAttention: boolean;
  createdAt: string;
  updatedAt: string;
  contentDigest: string | null;
};
export type CatalogReadSummary = {
  total: number;
  linked: number;
  unlinked: number;
  needsReview: number;
  needsAttention: number;
  published: number;
};
export type WorkspaceReadRepository = ReturnType<
  typeof createWorkspaceReadRepository
>;

function offset(input: PageQuery) {
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    !Number.isInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > 100 ||
    !Number.isSafeInteger((input.page - 1) * input.pageSize)
  )
    throw new Error("invalid read pagination");
  return (input.page - 1) * input.pageSize;
}

/** Projections select IDs before hydration. Every join and UNION arm is explicitly scoped. */
export function createWorkspaceReadRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  const catalog = sql`
  select p.id, p.remote_product_id as "remoteProductId",p.origin,p.sku,p.listing_id as "listingId",
   p.spec_version as "specVersion",coalesce(v.content->'title'->>'zh-Hant',v.content->'title'->>'en',p.sku,p.remote_product_id) as title,
   d.status as "listingStatus",case when d.id is null then null else coalesce(f.n,0) end as "openBlockingFlagCount",
   coalesce(d.status in ('in_review','reopened'),false) as "needsReview",
   (p.listing_id is null or d.id is null or d.status in ('needs_info','publish_failed','failed') or coalesce(f.n,0)>0) as "needsAttention",
   p.created_at as "createdAt",p.updated_at as "updatedAt",p.content_digest as "contentDigest"
  from platform_products p
  left join listing_drafts d on d.id=p.listing_id and d.workspace_id=${workspaceId}
  left join listing_versions v on v.id=d.active_version_id and v.workspace_id=${workspaceId}
  left join (select listing_version_id,count(*)::int n from compliance_flags
    where workspace_id=${workspaceId} and status='open' and severity='blocking' group by listing_version_id) f on f.listing_version_id=d.active_version_id
  where p.workspace_id=${workspaceId}`;
  const ledger = sql`
  select id,'batch'::text kind,created_at from enrichment_batches where workspace_id=${workspaceId}
  union all select id,'publish_job',created_at from publish_jobs where workspace_id=${workspaceId}
  union all select id,'pipeline_run',created_at from listing_pipeline_runs where workspace_id=${workspaceId}
  union all select id,'export',created_at from export_attempts where workspace_id=${workspaceId}
  union all select id,'import_result',created_at from import_results where workspace_id=${workspaceId}`;
  return {
    async catalogPage(
      input: PageQuery & { q?: string; filter: CatalogFilter },
    ) {
      scope.assertOpen();
      const skip = offset(input);
      if (
        !["all", "attention", "review", "unlinked", "published"].includes(
          input.filter,
        )
      )
        throw new Error("invalid catalog filter");
      const q = (input.q ?? "").trim().toLocaleLowerCase();
      const match = sql`(${input.filter}='all' or (${input.filter}='attention' and "needsAttention") or (${input.filter}='review' and "needsReview") or (${input.filter}='unlinked' and "listingId" is null) or (${input.filter}='published' and "listingStatus"='published'))
    and (${q}='' or strpos(lower(title),${q})>0 or strpos(lower(sku),${q})>0 or strpos(lower("remoteProductId"),${q})>0 or strpos(lower("specVersion"),${q})>0)`;
      // One statement gives counts and page a common MVCC snapshot, including empty pages.
      const rows =
        await transaction.execute(sql`with catalog as materialized (${catalog}), matching as (select * from catalog where ${match}),
    page as (select * from matching order by "updatedAt" desc,id desc limit ${input.pageSize} offset ${skip})
    select (select coalesce(jsonb_agg(to_jsonb(page) order by "updatedAt" desc,id desc),'[]') from page) items,
     (select count(*)::int from matching) as "totalMatching",
     jsonb_build_object('total',count(*)::int,'linked',count(*) filter(where "listingId" is not null)::int,
      'unlinked',count(*) filter(where "listingId" is null)::int,'needsReview',count(*) filter(where "needsReview")::int,
      'needsAttention',count(*) filter(where "needsAttention")::int,'published',count(*) filter(where "listingStatus"='published')::int) summary from catalog`);
      const row = rows[0]!;
      return {
        items: row.items as CatalogReadItem[],
        totalMatching: Number(row.totalMatching),
        summary: row.summary as CatalogReadSummary,
      };
    },
    async listingPage(
      input: PageQuery & { status?: ListingStatus; q?: string },
    ) {
      scope.assertOpen();
      const skip = offset(input);
      const q = (input.q ?? "").trim().toLocaleLowerCase();
      const rows = await transaction.execute(sql`with matching as (
    select d.id,d.updated_at from listing_drafts d
    left join listing_versions v on v.id=d.active_version_id and v.workspace_id=${workspaceId}
    where d.workspace_id=${workspaceId} and (${input.status ?? null}::text is null or d.status::text=${input.status ?? null})
    and (${q}='' or strpos(lower(coalesce(v.content->'title'->>'zh-Hant',v.content->'title'->>'en',d.note,'')),${q})>0 or strpos(lower(v.content->>'sku'),${q})>0)
   ), page as (select * from matching order by updated_at desc,id desc limit ${input.pageSize} offset ${skip})
   select (select coalesce(jsonb_agg(id order by updated_at desc,id desc),'[]') from page) ids,(select count(*)::int from matching) as "totalMatching"`);
      return {
        ids: rows[0]!.ids as string[],
        totalMatching: Number(rows[0]!.totalMatching),
      };
    },
    async scanListingIds(afterId?: string, limit = 100) {
      scope.assertOpen();
      offset({ page: 1, pageSize: limit });
      const rows = await transaction.execute(
        sql`select id from listing_drafts where workspace_id=${workspaceId} and (${afterId ?? null}::uuid is null or id>${afterId ?? null}::uuid) order by id limit ${limit}`,
      );
      return rows.map((row) => String(row.id));
    },
    async jobsPage(input: PageQuery & { kind?: LedgerKind }) {
      scope.assertOpen();
      const skip = offset(input);
      if (
        input.kind &&
        ![
          "batch",
          "publish_job",
          "pipeline_run",
          "export",
          "import_result",
        ].includes(input.kind)
      )
        throw new Error("invalid ledger kind");
      const rows =
        await transaction.execute(sql`with ledger as materialized (${ledger}),
    matching as (select * from ledger where ${input.kind ?? null}::text is null or kind=${input.kind ?? null}),
    page as (select * from matching order by created_at desc,id desc,kind desc limit ${input.pageSize} offset ${skip})
    select (select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind) order by created_at desc,id desc,kind desc),'[]') from page) items,
     (select count(*)::int from matching) as "totalMatching",
     (select count(*)::int from ledger) as total,
     (select coalesce(jsonb_object_agg(kind,n),'{}') from (select kind,count(*)::int n from ledger group by kind) c) counts`);
      const row = rows[0]!;
      return {
        items: row.items as { id: string; kind: LedgerKind }[],
        totalMatching: Number(row.totalMatching),
        total: Number(row.total),
        counts: {
          batch: 0,
          publish_job: 0,
          pipeline_run: 0,
          export: 0,
          import_result: 0,
          ...(row.counts as Partial<Record<LedgerKind, number>>),
        },
      };
    },
  };
}
