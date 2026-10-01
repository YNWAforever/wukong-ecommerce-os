import { readReviewQualityEvidence } from "./review-quality.js";
import { sql } from "drizzle-orm";
import {
  reviewableListingSchema,
  type ComplianceFlag,
  type ListingStatus,
  type WebsiteProduct,
} from "@wukong/core";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { ListingDataError } from "../listing-data-error.js";
import {
  toPlatformProduct,
  type PlatformProduct,
} from "./platform-products.js";
import type { BulkUpdateApprovalReceipt } from "./approval-receipts.js";
import type { ReviewConfirmation } from "./review-confirmations.js";
import type { SourceRowSnapshot } from "./source-rows.js";

export type SourceReadinessRecord = {
  id: string;
  state: {
    status: ListingStatus;
    activeVersionId: string | null;
    flags: ComplianceFlag[];
  };
  link: PlatformProduct | null;
  receipt: BulkUpdateApprovalReceipt | null;
  currentConfirmation: ReviewConfirmation | null;
  inheritedConfirmation: ReviewConfirmation | null;
  sourceRow: SourceRowSnapshot | null;
  error: ListingDataError | null;
};
export type SourceReadinessBundle = {
  listings: SourceReadinessRecord[];
  imports: Array<{
    id: string;
    merchantAttestedExportAt: Date;
    headerContractSha256: string;
  }>;
};
// SQL JSON preserves timestamp precision for cursors; repository records retain
// their established camel-case/Date shape. Do not recurse into merchant jsonb.
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      item,
    ]),
  );
}

export type ReadCursorPosition = {
  at: string;
  id: string;
  tie: string;
  direction: "next" | "previous";
};
export type PageQuery = {
  page: number;
  pageSize: number;
  cursor?: ReadCursorPosition;
};
function cursor(input: PageQuery, ties: readonly string[]) {
  const value = input.cursor;
  if (
    value &&
    (!ties.includes(value.tie) ||
      !["next", "previous"].includes(value.direction) ||
      !/^[0-9a-f-]{36}$/i.test(value.id) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value.at,
      ) ||
      !Number.isFinite(Date.parse(value.at)))
  )
    throw new Error("invalid read cursor");
  return value;
}
function pageCursors<T extends { id: string }>(
  rows: T[],
  input: PageQuery,
  position: (row: T) => Omit<ReadCursorPosition, "direction">,
) {
  const more = rows.length > input.pageSize,
    backward = input.cursor?.direction === "previous";
  const items = rows.slice(0, input.pageSize);
  if (backward) items.reverse();
  return {
    items,
    nextCursor:
      items.length && (backward || more)
        ? { ...position(items.at(-1)!), direction: "next" as const }
        : null,
    previousCursor:
      items.length && (backward ? more : input.page > 1 || !!input.cursor)
        ? { ...position(items[0]!), direction: "previous" as const }
        : null,
  };
}
export type CatalogFilter =
  | "workbook"
  | "website"
  | "all"
  | "drafts"
  | "bound"
  | "attention"
  | "review"
  | "unlinked"
  | "published";
export type LedgerKind =
  "batch" | "publish_job" | "pipeline_run" | "export" | "import_result";
export type PlatformCatalogReadItem = {
  sourceType: "platform";
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
export type WebsiteCatalogReadItem = {
  sourceType: "website";
  id: string;
  title: string;
  sourceUrl: string;
  capturedAt: string;
  createdAt: string;
  updatedAt: string;
  canExport: false;
};
export type WorkbookCatalogReadItem = {
  sourceType: "workbook";
  id: string;
  title: string;
  sku: string;
  sourceProductId: string;
  createdAt: string;
  updatedAt: string;
  canExport: false;
};
export type CatalogReadItem =
  | PlatformCatalogReadItem
  | WebsiteCatalogReadItem
  | WorkbookCatalogReadItem
  | DraftCatalogReadItem;
export type DraftCatalogReadItem = {
  sourceType: "draft";
  id: string;
  listingId: string;
  title: string;
  sku: string | null;
  listingStatus: ListingStatus;
  openBlockingFlagCount: number;
  needsReview: boolean;
  needsAttention: boolean;
  createdAt: string;
  updatedAt: string;
  canExport: false;
};
export type CatalogReadSummary = {
  website: number;
  workbook: number;
  total: number;
  linked: number;
  unlinked: number;
  needsReview: number;
  needsAttention: number;
  published: number;
  referenceRows: number;
  drafts: number;
  boundProducts: number;
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
  // Human-owned or locked current input takes precedence over an older AI version.
  // Both projections join the same workspace/listing/revision before using it.
  const currentTitleZh = sql`case when i.id is null then v.content->'title'->>'zh-Hant' when v.id is null or i.field_states->'title.zh-Hant'->>'owner'='operator' or i.field_states->'title.zh-Hant'->>'locked'='true' then i.working_content->'title'->>'zh-Hant' else v.content->'title'->>'zh-Hant' end`;
  const currentTitleEn = sql`case when i.id is null then v.content->'title'->>'en' when v.id is null or i.field_states->'title.en'->>'owner'='operator' or i.field_states->'title.en'->>'locked'='true' then i.working_content->'title'->>'en' else v.content->'title'->>'en' end`;
  const titleJoins = sql`left join listing_input_revisions i on i.workspace_id=${workspaceId} and i.listing_id=d.id and i.revision=d.input_revision
    left join listing_versions v on v.id=d.active_version_id and v.workspace_id=${workspaceId} and v.listing_id=d.id`;
  const catalog = (withTitles: boolean) => sql`
  select 'platform'::text as "sourceType",null::text as "sourceUrl",null::text as "capturedAt", p.id, p.remote_product_id as "remoteProductId",p.origin,p.sku,p.listing_id as "listingId",
   p.spec_version as "specVersion",coalesce(${withTitles ? sql`nullif(${currentTitleZh},''),nullif(${currentTitleEn},''),` : sql``}p.sku,p.remote_product_id) as title,
   d.status as "listingStatus",case when d.id is null then null else coalesce(f.n,0) end as "openBlockingFlagCount",
   coalesce(d.status in ('in_review','reopened'),false) as "needsReview",
   (p.listing_id is null or d.id is null or d.status in ('needs_info','publish_failed','failed') or coalesce(f.n,0)>0) as "needsAttention",
   p.created_at as "createdAt",p.updated_at as "updatedAt",p.content_digest as "contentDigest",null::text as "sourceProductId"
  from platform_products p
  left join listing_drafts d on d.id=p.listing_id and d.workspace_id=${workspaceId}
  ${withTitles ? titleJoins : sql``}
  left join (select listing_version_id,count(*)::int n from compliance_flags
    where workspace_id=${workspaceId} and status='open' and severity='blocking' group by listing_version_id) f on f.listing_version_id=d.active_version_id
  where p.workspace_id=${workspaceId}
  union all select 'website',w.canonical_source_url,w.observation->>'capturedAt',w.id,null,null,null,null,null,w.observation->>'title',null,null,false,false,w.created_at,w.created_at,null,null
  from website_products w where w.workspace_id=${workspaceId}
  union all select 'workbook',null,null,w.id,null,null,w.product->>'sku',null,null,coalesce(w.product->'title'->>'zh-Hant',w.product->'title'->>'en',w.product->>'sku'),null,null,false,false,w.created_at,w.created_at,null,w.product->>'productId'
  from workbook_products w where w.workspace_id=${workspaceId}
  union all select 'draft',null,null,d.id,null,null,${withTitles ? sql`case when i.id is not null then i.working_content->>'sku' else v.content->>'sku' end` : sql`null::text`},d.id,null,
   coalesce(${withTitles ? sql`nullif(${currentTitleZh},''),nullif(${currentTitleEn},''),` : sql``}nullif(left(d.note,120),''),d.id::text),
   d.status,coalesce(f.n,0),d.status in ('in_review','reopened'),
   (d.status in ('needs_info','publish_failed','failed') or coalesce(f.n,0)>0),d.created_at,d.updated_at,null,null
  from listing_drafts d
  ${withTitles ? titleJoins : sql``}
  left join (select listing_version_id,count(*)::int n from compliance_flags where workspace_id=${workspaceId} and status='open' and severity='blocking' group by listing_version_id) f on f.listing_version_id=d.active_version_id
  where d.workspace_id=${workspaceId} and not exists(select 1 from platform_products p where p.workspace_id=${workspaceId} and p.listing_id=d.id)`;
  const ledger = sql`
  select id,'batch'::text kind,created_at from enrichment_batches where workspace_id=${workspaceId}
  union all select id,'publish_job',created_at from publish_jobs where workspace_id=${workspaceId}
  union all select id,'pipeline_run',created_at from listing_pipeline_runs where workspace_id=${workspaceId}
  union all select id,'export',created_at from export_attempts where workspace_id=${workspaceId}
  union all select id,'import_result',created_at from import_results where workspace_id=${workspaceId}`;
  return {
    async sourceReadinessBatch(
      listingIds: readonly string[],
      sourceImportIds: readonly string[] = [],
    ): Promise<SourceReadinessBundle> {
      scope.assertOpen();
      if (listingIds.length > 100 || sourceImportIds.length > 100)
        throw new Error("readiness batch must be bounded to 100");
      if (!listingIds.length && !sourceImportIds.length)
        return { listings: [], imports: [] };
      const ids = sql.join(
        [...new Set(listingIds)].map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const imports = sql.join(
        [...new Set(sourceImportIds)].map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      // One statement: all policy dependencies share a snapshot. SQL/permission
      // failures deliberately escape; only already-fetched malformed rows isolate.
      const rows =
        await transaction.execute(sql`with requested as materialized (
        select d.id,d.status,d.active_version_id,v.id version_id,v.content,v.source_import_id,v.source_row_digest
        from listing_drafts d left join listing_versions v on v.workspace_id=${workspaceId} and v.listing_id=d.id and v.id=d.active_version_id
        where d.workspace_id=${workspaceId} and ${listingIds.length ? sql`d.id in (${ids})` : sql`false`}
      ), data as materialized (
        select d.*,to_jsonb(p) link,to_jsonb(r) receipt,to_jsonb(c) current_confirmation,to_jsonb(ic) inherited_confirmation,to_jsonb(s) source_row,
          coalesce((select jsonb_agg(jsonb_build_object('code',f.code,'severity',f.severity,'status',f.status,'details',f.details)) from compliance_flags f where f.workspace_id=${workspaceId} and f.listing_version_id=d.version_id),'[]') flags
        from requested d
        left join lateral (select * from platform_products p where p.workspace_id=${workspaceId} and p.listing_id=d.id order by p.updated_at desc,p.id desc limit 1) p on true
        left join lateral (select r.id,r.listing_id,r.version_id,r.source_snapshot_id,r.confirmation_version_id,r.confirmation_revision,r.created_at,
          s.connection_id,s.source_import_id,s.remote_product_id,s.source_row_digest,s.header_contract_sha256,s.spec_version
          from bulk_update_approval_receipts r join source_row_snapshots s on s.workspace_id=${workspaceId} and s.workspace_id=r.workspace_id and s.id=r.source_snapshot_id
          where r.workspace_id=${workspaceId} and r.version_id=d.version_id order by r.receipt_ordinal desc limit 1) r on true
        left join review_confirmations c on c.workspace_id=${workspaceId} and c.version_id=d.version_id
        left join review_confirmations ic on ic.workspace_id=${workspaceId} and ic.version_id=r.confirmation_version_id
        left join source_row_snapshots s on s.workspace_id=${workspaceId} and s.source_import_id=p.source_import_id and s.connection_id=p.connection_id and s.remote_product_id=p.remote_product_id
      ) select (select coalesce(jsonb_agg(to_jsonb(data)),'[]') from data) listings,
        (select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'merchantAttestedExportAt',s.merchant_attested_export_at,'headerContractSha256',s.header_contract_sha256)),'[]')
         from source_imports s where s.workspace_id=${workspaceId} and (s.id in (select (link->>'source_import_id')::uuid from data) or ${sourceImportIds.length ? sql`s.id in (${imports})` : sql`false`})) imports`);
      const row = rows[0]!;
      return {
        imports: (
          row.imports as Array<{
            id: string;
            merchantAttestedExportAt: string;
            headerContractSha256: string;
          }>
        ).map((item) => ({
          ...item,
          merchantAttestedExportAt: new Date(item.merchantAttestedExportAt),
        })),
        listings: (row.listings as Array<Record<string, unknown>>).map(
          (raw) => {
            let error: ListingDataError | null = null;
            let link: PlatformProduct | null = null;
            try {
              if (raw.active_version_id && !raw.version_id)
                throw new ListingDataError("missing_active_version");
              if (
                raw.version_id &&
                !reviewableListingSchema.safeParse(raw.content).success
              )
                throw new ListingDataError("invalid_active_version");
              const p = record(raw.link);
              if (p) {
                const { workspaceId: _workspaceId, ...product } = p;
                link = toPlatformProduct({
                  ...product,
                  createdAt: new Date(String(p.createdAt)),
                  updatedAt: new Date(String(p.updatedAt)),
                } as Parameters<typeof toPlatformProduct>[0]);
              }
            } catch (failure) {
              if (!(failure instanceof ListingDataError)) throw failure;
              error = failure;
            }
            const flags = (
              raw.flags as Array<{
                code: string;
                severity: string;
                status: string;
                details: Record<string, unknown> | null;
              }>
            ).flatMap((f): ComplianceFlag[] => {
              if (
                (f.severity !== "blocking" && f.severity !== "warning") ||
                (f.status !== "open" && f.status !== "resolved")
              )
                return [];
              const details = f.details ?? {};
              const base = {
                id:
                  typeof details.id === "string"
                    ? details.id
                    : `${f.code}:${String(details.field ?? "unknown")}`,
                field:
                  typeof details.field === "string" ? details.field : "unknown",
                rule: f.code as ComplianceFlag["rule"],
                severity: f.severity as "blocking" | "warning",
              };
              return [
                f.status === "resolved"
                  ? {
                      ...base,
                      status: "resolved",
                      resolutionReason:
                        typeof details.resolutionReason === "string"
                          ? details.resolutionReason
                          : "",
                    }
                  : { ...base, status: "open", resolutionReason: null },
              ];
            });
            return {
              id: String(raw.id),
              state: {
                status: raw.status as ListingStatus,
                activeVersionId: raw.version_id ? String(raw.version_id) : null,
                flags,
              },
              link,
              error,
              receipt: record(raw.receipt) as BulkUpdateApprovalReceipt | null,
              currentConfirmation: record(
                raw.current_confirmation,
              ) as ReviewConfirmation | null,
              inheritedConfirmation: record(
                raw.inherited_confirmation,
              ) as ReviewConfirmation | null,
              sourceRow: record(raw.source_row) as SourceRowSnapshot | null,
            };
          },
        ),
      };
    },
    reviewQualityEvidence(start: string, end: string) {
      return readReviewQualityEvidence(
        transaction,
        workspaceId,
        scope,
        start,
        end,
      );
    },
    async catalogPage(
      input: PageQuery & {
        q?: string;
        filter: CatalogFilter;
        importId?: string;
        work?: "all" | "mine" | "unassigned" | "review";
        actorId?: string;
      },
    ) {
      scope.assertOpen();
      const skip = offset(input);
      const position = cursor(input, [
        "platform",
        "draft",
        "website",
        "workbook",
      ]);
      if (
        ![
          "all",
          "drafts",
          "bound",
          "website",
          "workbook",
          "attention",
          "review",
          "unlinked",
          "published",
        ].includes(input.filter)
      )
        throw new Error("invalid catalog filter");
      const q = (input.q ?? "").trim().toLocaleLowerCase();
      const work = input.work ?? "all";
      if (
        !["all", "mine", "unassigned", "review"].includes(work) ||
        (work === "mine" && !input.actorId)
      )
        throw new Error("invalid responsibility filter");
      const responsibilityMatch =
        work === "all"
          ? sql`true`
          : work === "review"
            ? sql`"listingStatus"='in_review'`
            : sql`"listingId" is not null and ${
                work === "mine"
                  ? sql`exists(select 1 from listing_assignments a join memberships m on m.workspace_id=a.workspace_id and m.user_id=a.assignee_user_id and m.role in ('operator','reviewer','admin','owner') where a.workspace_id=${workspaceId} and a.listing_id="listingId" and a.assignee_user_id=${input.actorId})`
                  : sql`not exists(select 1 from listing_assignments a join memberships m on m.workspace_id=a.workspace_id and m.user_id=a.assignee_user_id and m.role in ('operator','reviewer','admin','owner') where a.workspace_id=${workspaceId} and a.listing_id="listingId")`
              }`;
      const importMatch = input.importId
        ? sql`("sourceType"='workbook' and id in (select id from workbook_products where workspace_id=${workspaceId} and import_id=${input.importId}::uuid))`
        : sql`true`;
      const filterMatch = {
        all: sql`true`,
        bound: sql`"sourceType"='platform' and "listingId" is not null`,
        drafts: sql`"listingId" is not null`,
        website: sql`"sourceType"='website'`,
        workbook: sql`"sourceType"='workbook'`,
        attention: sql`"needsAttention"`,
        review: sql`"needsReview"`,
        unlinked: sql`"sourceType"='platform' and "listingId" is null`,
        published: sql`"listingStatus"='published'`,
      }[input.filter];
      const searchMatch = q
        ? sql`strpos(lower(title),${q})>0 or strpos(lower("sourceUrl"),${q})>0 or strpos(lower("sourceProductId"),${q})>0 or strpos(lower(sku),${q})>0 or strpos(lower("remoteProductId"),${q})>0 or strpos(lower("specVersion"),${q})>0`
        : sql`true`;
      const match = sql`${importMatch} and (${filterMatch}) and ${responsibilityMatch} and (${searchMatch})`;
      const backward = position?.direction === "previous";
      const boundary = !position
        ? sql`true`
        : backward
          ? sql`("createdAt">${position.at}::timestamptz or ("createdAt"=${position.at}::timestamptz and ("sourceType"<${position.tie} or ("sourceType"=${position.tie} and id<${position.id}::uuid))))`
          : sql`("createdAt"<${position.at}::timestamptz or ("createdAt"=${position.at}::timestamptz and ("sourceType">${position.tie} or ("sourceType"=${position.tie} and id>${position.id}::uuid))))`;
      const ordering = backward
        ? sql`"createdAt" asc,"sourceType" desc,id desc`
        : sql`"createdAt" desc,"sourceType",id`;
      // One statement gives counts and page a common MVCC snapshot, including empty pages.
      const rows =
        await transaction.execute(sql`with catalog as materialized (${catalog(!!q)}), matching as (select * from catalog where ${match}),
    page as (select * from matching where ${boundary} order by ${ordering} limit ${input.pageSize + 1} offset ${position ? 0 : skip})
    select (select coalesce(jsonb_agg(to_jsonb(page) order by ${ordering}),'[]') from page) items,
     (select count(*)::int from matching) as "totalMatching",
     jsonb_build_object('total',count(*)::int,'linked',count(*) filter(where "sourceType"='platform' and "listingId" is not null)::int,
      'referenceRows',count(*) filter(where "sourceType" in ('website','workbook'))::int,
      'drafts',(select count(*)::int from listing_drafts where workspace_id=${workspaceId}),
      'boundProducts',count(*) filter(where "sourceType"='platform' and "listingId" is not null)::int,
      'workbook',count(*) filter(where "sourceType"='workbook')::int,'website',count(*) filter(where "sourceType"='website')::int,'unlinked',count(*) filter(where "sourceType"='platform' and "listingId" is null)::int,'needsReview',count(*) filter(where "needsReview")::int,
      'needsAttention',count(*) filter(where "needsAttention")::int,'published',count(*) filter(where "listingStatus"='published')::int) summary from catalog`);
      const row = rows[0]!;
      const pagination = pageCursors(
        row.items as CatalogReadItem[],
        input,
        (item) => ({ at: item.createdAt, id: item.id, tie: item.sourceType }),
      );
      const titleIds = !q
        ? [
            ...new Set(
              pagination.items.flatMap((item) =>
                (item.sourceType === "draft" ||
                  item.sourceType === "platform") &&
                item.listingId
                  ? [item.listingId]
                  : [],
              ),
            ),
          ]
        : [];
      const titles = titleIds.length
        ? await transaction.execute(sql`select d.id,coalesce(nullif(${currentTitleZh},''),nullif(${currentTitleEn},'')) title,
        case when i.id is not null then i.working_content->>'sku' else v.content->>'sku' end sku
        from listing_drafts d ${titleJoins} where d.workspace_id=${workspaceId} and d.id in (${sql.join(
          titleIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`)
        : [];
      const titleByListing = new Map(
        titles.map((item) => [String(item.id), item]),
      );
      for (const item of pagination.items) {
        if (item.sourceType !== "platform" && item.sourceType !== "draft")
          continue;
        const current = item.listingId
          ? titleByListing.get(item.listingId)
          : undefined;
        if (current?.title != null) item.title = String(current.title);
        if (item.sourceType === "draft" && current)
          item.sku = current.sku == null ? null : String(current.sku);
      }
      return {
        nextCursor: pagination.nextCursor,
        previousCursor: pagination.previousCursor,
        items: pagination.items.map((item) => {
          if (item.sourceType === "draft")
            return {
              sourceType: "draft" as const,
              id: item.id,
              listingId: item.listingId,
              title: item.title,
              sku: item.sku,
              listingStatus: item.listingStatus,
              openBlockingFlagCount: item.openBlockingFlagCount,
              needsReview: item.needsReview,
              needsAttention: item.needsAttention,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              canExport: false as const,
            };
          if (item.sourceType === "workbook")
            return {
              sourceType: "workbook" as const,
              id: item.id,
              title: item.title,
              sku: item.sku,
              sourceProductId: item.sourceProductId,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              canExport: false as const,
            };
          if (item.sourceType === "website")
            return {
              sourceType: "website" as const,
              id: item.id,
              title: item.title,
              sourceUrl: item.sourceUrl,
              capturedAt: item.capturedAt,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              canExport: false as const,
            };
          const {
            sourceUrl: _url,
            capturedAt: _capture,
            sourceProductId: _source,
            ...platform
          } = item as PlatformCatalogReadItem & {
            sourceUrl: null;
            capturedAt: null;
            sourceProductId: null;
          };
          return platform;
        }),
        totalMatching: Number(row.totalMatching),
        summary: row.summary as CatalogReadSummary,
      };
    },
    async websiteProduct(id: string) {
      scope.assertOpen();
      const rows = await transaction.execute(
        sql`select id,observation,created_at as "createdAt" from website_products where workspace_id=${workspaceId} and id=${id}::uuid`,
      );
      const row = rows[0];
      return row
        ? {
            sourceType: "website" as const,
            id: String(row.id),
            observation: row.observation as WebsiteProduct,
            createdAt: new Date(String(row.createdAt)).toISOString(),
            canExport: false as const,
          }
        : null;
    },
    async listingPage(
      input: PageQuery & { status?: ListingStatus; q?: string },
    ) {
      scope.assertOpen();
      const skip = offset(input);
      const position = cursor(input, ["listing"]);
      const backward = position?.direction === "previous";
      const boundary = !position
        ? sql`true`
        : backward
          ? sql`(updated_at>${position.at}::timestamptz or (updated_at=${position.at}::timestamptz and id>${position.id}::uuid))`
          : sql`(updated_at<${position.at}::timestamptz or (updated_at=${position.at}::timestamptz and id<${position.id}::uuid))`;
      const ordering = backward
        ? sql`updated_at asc,id asc`
        : sql`updated_at desc,id desc`;
      const q = (input.q ?? "").trim().toLocaleLowerCase();
      const rows = await transaction.execute(sql`with matching as (
    select d.id,d.updated_at from listing_drafts d
    left join listing_versions v on v.id=d.active_version_id and v.workspace_id=${workspaceId}
    where d.workspace_id=${workspaceId} and (${input.status ?? null}::text is null or d.status::text=${input.status ?? null})
    and (${q}='' or strpos(lower(coalesce(v.content->'title'->>'zh-Hant',v.content->'title'->>'en',d.note,'')),${q})>0 or strpos(lower(v.content->>'sku'),${q})>0)
   ), page as (select * from matching where ${boundary} order by ${ordering} limit ${input.pageSize + 1} offset ${position ? 0 : skip})
   select (select coalesce(jsonb_agg(jsonb_build_object('id',id,'at',updated_at) order by ${ordering}),'[]') from page) items,(select count(*)::int from matching) as "totalMatching"`);
      const pagination = pageCursors(
        rows[0]!.items as { id: string; at: string }[],
        input,
        (item) => ({ id: item.id, at: item.at, tie: "listing" }),
      );
      return {
        ids: pagination.items.map((item) => item.id),
        nextCursor: pagination.nextCursor,
        previousCursor: pagination.previousCursor,
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
      const position = cursor(input, [
        "batch",
        "publish_job",
        "pipeline_run",
        "export",
        "import_result",
      ]);
      const backward = position?.direction === "previous";
      const boundary = !position
        ? sql`true`
        : backward
          ? sql`(created_at>${position.at}::timestamptz or (created_at=${position.at}::timestamptz and (id>${position.id}::uuid or (id=${position.id}::uuid and kind>${position.tie}))))`
          : sql`(created_at<${position.at}::timestamptz or (created_at=${position.at}::timestamptz and (id<${position.id}::uuid or (id=${position.id}::uuid and kind<${position.tie}))))`;
      const ordering = backward
        ? sql`created_at asc,id asc,kind asc`
        : sql`created_at desc,id desc,kind desc`;
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
    page as (select * from matching where ${boundary} order by ${ordering} limit ${input.pageSize + 1} offset ${position ? 0 : skip})
    select (select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'at',created_at) order by ${ordering}),'[]') from page) items,
     (select count(*)::int from matching) as "totalMatching",
     (select count(*)::int from ledger) as total,
     (select coalesce(jsonb_object_agg(kind,n),'{}') from (select kind,count(*)::int n from ledger group by kind) c) counts`);
      const row = rows[0]!;
      const pagination = pageCursors(
        row.items as { id: string; kind: LedgerKind; at: string }[],
        input,
        (item) => ({ id: item.id, at: item.at, tie: item.kind }),
      );
      return {
        items: pagination.items.map(({ id, kind }) => ({ id, kind })),
        nextCursor: pagination.nextCursor,
        previousCursor: pagination.previousCursor,
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
