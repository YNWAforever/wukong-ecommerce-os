import { sql } from "drizzle-orm";
import type { WorkspaceTransaction, WorkspaceScope } from "../client.js";
import type {
  EnrichmentIdentity,
  MatchedWebsiteSuggestion,
} from "@wukong/core";
export type ListingEnrichmentPayload = {
  url: string;
  identity: EnrichmentIdentity;
  inputContextDigest: string;
  identityContextDigest?: string;
  sourceContextDigest?: string;
  result: MatchedWebsiteSuggestion | null;
  errorCode: string | null;
};
export type ListingEnrichmentSuggestion = {
  id: string;
  listingId: string;
  inputRevision: number;
  baseVersionId: string | null;
  rejectedFields?: string[];
  requestKey: string;
  requestDigest: string;
  payload: ListingEnrichmentPayload;
};
export function createListingEnrichmentRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  const map = (row: Record<string, unknown>): ListingEnrichmentSuggestion => ({
    id: String(row.id),
    listingId: String(row.listing_id),
    inputRevision: Number(row.input_revision),
    baseVersionId: row.base_version_id ? String(row.base_version_id) : null,
    requestKey: String(row.request_key),
    requestDigest: String(row.request_digest),
    payload: row.payload as ListingEnrichmentPayload,
  });
  return {
    async bindVersionClaims(input: {
      listingId: string;
      versionId: string;
      supportIds: string[];
      inputRevision: number;
      actorId: string;
    }) {
      scope.assertOpen();
      for (const id of input.supportIds)
        await tx.execute(
          sql`insert into listing_version_claim_supports(workspace_id,listing_id,version_id,support_id,input_revision,actor_id) values(${workspaceId},${input.listingId}::uuid,${input.versionId}::uuid,${id}::uuid,${input.inputRevision},${input.actorId}) on conflict do nothing`,
        );
    },
    async versionClaimIds(listingId: string, versionId: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select support_id from listing_version_claim_supports where workspace_id=${workspaceId} and listing_id=${listingId}::uuid and version_id=${versionId}::uuid`,
      );
      return rows.map((row) => String(row.support_id));
    },
    async claimSupportReady() {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select to_regclass('public.listing_claim_supports') is not null and to_regclass('public.listing_version_claim_supports') is not null ready`,
      );
      return rows[0]?.ready === true;
    },
    async claimSupportByKey(listingId: string, key: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select * from listing_claim_supports where workspace_id=${workspaceId} and listing_id=${listingId}::uuid and request_key=${key}::uuid`,
      );
      return rows[0] ?? null;
    },
    async recordClaimSupport(input: {
      listingId: string;
      suggestionId: string;
      inputRevision: number;
      baseVersionId: string | null;
      requestKey: string;
      requestDigest: string;
      actorId: string;
      payload: Record<string, unknown>;
    }) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`insert into listing_claim_supports(workspace_id,listing_id,suggestion_id,input_revision,base_version_id,request_key,request_digest,actor_id,payload) values(${workspaceId},${input.listingId}::uuid,${input.suggestionId}::uuid,${input.inputRevision},${input.baseVersionId}::uuid,${input.requestKey}::uuid,${input.requestDigest},${input.actorId},${JSON.stringify(input.payload)}::jsonb) returning id`,
      );
      return String(rows[0]!.id);
    },
    async claimSupports(listingId: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select c.*, (select s.payload->'identity' from listing_enrichment_suggestions s where s.workspace_id=c.workspace_id and s.listing_id=c.listing_id and s.id=c.suggestion_id) matched_identity, exists(select 1 from listing_input_revisions r where r.workspace_id=c.workspace_id and r.listing_id=c.listing_id and r.revision>c.input_revision and ((r.working_content #>> string_to_array(c.payload->>'copyField','.')) is distinct from c.payload->>'copyText' or jsonb_build_object('producer',r.working_content->'producer','productType',r.working_content->'productType','country',r.working_content->'country','region',r.working_content->'region','vintage',r.working_content->'vintage','volumeMl',r.working_content->'volumeMl','packQuantity',r.working_content->'packQuantity','title',r.working_content->'title') is distinct from c.payload->'identitySnapshot' or jsonb_build_object('note',r.note,'sources',r.sources) is distinct from c.payload->'sourceSnapshot')) invalidated, exists(select 1 from listing_enrichment_decisions d join listing_enrichment_suggestions s on s.workspace_id=d.workspace_id and s.listing_id=d.listing_id and s.id=d.suggestion_id cross join lateral jsonb_array_elements(coalesce(s.payload #> '{result,claims}','[]'::jsonb)) with ordinality obs(value,ordinality) where d.workspace_id=c.workspace_id and d.listing_id=c.listing_id and d.suggestion_id=c.suggestion_id and obs.value->'claim'=c.payload->'claim' and d.selected_fields @> jsonb_build_array('claim:'||(obs.ordinality-1)::text)) rejected from listing_claim_supports c where c.workspace_id=${workspaceId} and c.listing_id=${listingId}::uuid order by c.created_at desc`,
      );
      return rows;
    },
    async decisionByKey(listingId: string, key: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select id,request_digest,input_revision from listing_enrichment_decisions where workspace_id=${workspaceId} and listing_id=${listingId}::uuid and request_key=${key}::uuid`,
      );
      return rows[0] ?? null;
    },
    async rejectedFields(listingId: string, suggestionId: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select selected_fields from listing_enrichment_decisions where workspace_id=${workspaceId} and listing_id=${listingId}::uuid and suggestion_id=${suggestionId}::uuid`,
      );
      return [
        ...new Set(rows.flatMap((row) => row.selected_fields as string[])),
      ];
    },
    async reject(input: {
      listingId: string;
      suggestionId: string;
      inputRevision: number;
      baseVersionId: string | null;
      requestKey: string;
      requestDigest: string;
      actorId: string;
      selectedFields: string[];
    }) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`insert into listing_enrichment_decisions(workspace_id,listing_id,suggestion_id,input_revision,base_version_id,request_key,request_digest,actor_id,selected_fields,decision) values(${workspaceId},${input.listingId}::uuid,${input.suggestionId}::uuid,${input.inputRevision},${input.baseVersionId}::uuid,${input.requestKey}::uuid,${input.requestDigest},${input.actorId},${JSON.stringify(input.selectedFields)}::jsonb,'reject') returning id`,
      );
      return rows[0]!;
    },
    async isReady() {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select to_regclass('public.listing_enrichment_suggestions') is not null and to_regclass('public.listing_enrichment_decisions') is not null ready`,
      );
      return rows[0]?.ready === true;
    },
    async latest(listingId: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select * from listing_enrichment_suggestions where workspace_id=${workspaceId} and listing_id=${listingId}::uuid order by created_at desc,id desc limit 1`,
      );
      return rows[0]
        ? {
            ...map(rows[0]),
            rejectedFields: await this.rejectedFields(
              listingId,
              String(rows[0].id),
            ),
          }
        : null;
    },
    async get(listingId: string, id: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select * from listing_enrichment_suggestions where workspace_id=${workspaceId} and listing_id=${listingId}::uuid and id=${id}::uuid`,
      );
      return rows[0]
        ? {
            ...map(rows[0]),
            rejectedFields: await this.rejectedFields(
              listingId,
              String(rows[0].id),
            ),
          }
        : null;
    },
    async getByKey(listingId: string, key: string) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select * from listing_enrichment_suggestions where workspace_id=${workspaceId} and listing_id=${listingId}::uuid and request_key=${key}::uuid`,
      );
      return rows[0]
        ? {
            ...map(rows[0]),
            rejectedFields: await this.rejectedFields(
              listingId,
              String(rows[0].id),
            ),
          }
        : null;
    },
    async record(input: Omit<ListingEnrichmentSuggestion, "id">) {
      scope.assertOpen();
      if (Buffer.byteLength(JSON.stringify(input.payload)) > 250000)
        throw new Error("suggestion_too_large");
      const rows = await tx.execute(
        sql`insert into listing_enrichment_suggestions(workspace_id,listing_id,input_revision,base_version_id,request_key,request_digest,payload) values(${workspaceId},${input.listingId}::uuid,${input.inputRevision},${input.baseVersionId}::uuid,${input.requestKey}::uuid,${input.requestDigest},${JSON.stringify(input.payload)}::jsonb) on conflict(workspace_id,listing_id,request_key) do nothing returning *`,
      );
      return rows[0]
        ? map(rows[0])
        : this.getByKey(input.listingId, input.requestKey);
    },
  };
}
export type ListingEnrichmentRepository = ReturnType<
  typeof createListingEnrichmentRepository
>;
