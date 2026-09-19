import { createAiBudgetReservationRepository } from "./ai-budget-reservations.js";
import { createSearchBudgetReservationRepository } from "./search-budget-reservations.js";
import {
  wineSearchOutputSchema,
  wineSearchDiagnosticSchema,
  type WineSearchOutput,
  type WineSearchDiagnostic,
} from "@wukong/jobs";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  wineBudgetSnapshotSchema,
  evidenceSourceSchema,
  wineSourceAuthoritySchema,
  wineContentSchema,
  reviewableListingSchema,
  type ReviewableListing,
  productIdentitySchema,
  supportedClaimSchema,
  type EvidenceSource,
  type WineSourceAuthority,
  type WineStage,
  type WineContent,
} from "@wukong/core";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
export type StageRecord = {
  runId: string;
  stage: WineStage;
  inputDigest: string;
  state: "started" | "succeeded" | "failed" | "skipped" | "unknown";
  output: unknown;
  dependencyDigest: string;
  updatedAt: string;
};
export type SearchCall = {
  runId: string;
  slot: "basic_1" | "basic_2" | "advanced_1" | "extract_1";
  maximumCredits: number;
  requestDigest: string;
};
// Server-only context. Acquisition/generation inputs must never be mapped into these trust arrays.
export const wineTrustedContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: productIdentitySchema,
    policyVersion: z.string().min(1),
    authorities: z.array(wineSourceAuthoritySchema),
    supports: z.array(
      z
        .object({
          sourceId: z.uuid(),
          field: supportedClaimSchema.shape.field,
          value: supportedClaimSchema.shape.value,
          span: z.string().min(1),
          originalAuthority: z.string().min(1).optional(),
          applicableVintage: z
            .union([
              z
                .object({
                  state: z.literal("known"),
                  year: z.number().int().min(1800).max(2200),
                })
                .strict(),
              z
                .object({
                  state: z.enum(["unknown", "not_applicable"]),
                  year: z.null(),
                })
                .strict(),
            ])
            .optional(),
        })
        .strict(),
    ),
    reliableSourceIds: z.array(z.uuid()),
    trustedObservationSourceIds: z.array(z.uuid()),
    acceptedPremises: z.array(supportedClaimSchema),
    verifiedAliases: z.array(
      z
        .object({
          producer: z.string().min(1),
          canonicalName: z.string().min(1),
          alias: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type WineTrustedContext = z.infer<typeof wineTrustedContextSchema>;
export type SearchCallRecord = SearchCall & {
  status: "started" | "succeeded" | "failed" | "unknown";
  credits: number | null;
  output: WineSearchOutput | null;
  diagnostic: WineSearchDiagnostic | null;
  updatedAt: string;
};
export type WineVersionOrigin = {
  versionId: string;
  workspaceId: string;
  listingId: string;
  sequence: number;
  pipelineIdempotencyKey: string | null;
  content: ReviewableListing;
  runId: string | null;
  sections: WineContent | null;
};
export type WineEnrichmentRepository = {
  readUsage(
    runId: string,
  ): Promise<{ goEstimatedUsd: string | null; tavilyCredits: number | null }>;
  readVersionOrigin(
    listingId: string,
    versionId: string,
  ): Promise<WineVersionOrigin | null>;
  settleTerminalBudgets(runId: string): Promise<void>;
  readSearchCall(
    runId: string,
    slot: SearchCall["slot"],
  ): Promise<SearchCallRecord | null>;
  claimStage(
    input: Omit<StageRecord, "output" | "updatedAt" | "state">,
  ): Promise<boolean>;
  readStage(runId: string, stage: WineStage): Promise<StageRecord | null>;
  finishStage(input: StageRecord): Promise<boolean>;
  beginSearchCall(input: SearchCall): Promise<boolean>;
  finishSearchCall(
    input: SearchCall & {
      credits: number | null;
      status: string;
      output?: WineSearchOutput;
      diagnostic?: WineSearchDiagnostic;
    },
  ): Promise<boolean>;
  saveEvidence(runId: string, sources: EvidenceSource[]): Promise<void>;
  readEvidence(runId: string): Promise<EvidenceSource[]>;
  recordReviewedAuthority(
    authenticatedActorId: string,
    authority: WineSourceAuthority,
  ): Promise<void>;
  /** Hold workspace NO KEY UPDATE through the authoritative decision transaction. */
  lockAuthorities(): Promise<void>;
  readAuthorities(): Promise<WineSourceAuthority[]>;
  saveTrustedContext(input: {
    runId: string;
    contextKey: string;
    inputDigest: string;
    context: WineTrustedContext;
  }): Promise<void>;
  readTrustedContext(
    runId: string,
    contextKey: string,
    inputDigest: string,
  ): Promise<WineTrustedContext | null>;
  saveSections(input: {
    runId: string;
    listingId: string;
    versionId: string;
    content: WineContent;
  }): Promise<void>;
  readSections(runId: string, versionId: string): Promise<WineContent | null>;
};
const json = (value: unknown) => JSON.stringify(value);
export function createWineEnrichmentRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WineEnrichmentRepository {
  async function immutableInsert(
    table: string,
    keys: Record<string, string>,
    payload: unknown,
  ) {
    scope.assertOpen();
    const predicates = Object.entries(keys).map(
      ([key, value]) => sql`${sql.identifier(key)}=${value}`,
    );
    const columns = ["workspace_id", ...Object.keys(keys), "payload"].map(
      (key) => sql.identifier(key),
    );
    const values = [
      sql`${workspaceId}`,
      ...Object.values(keys).map((value) => sql`${value}`),
      sql`${json(payload)}::jsonb`,
    ];
    await tx.execute(
      sql`insert into ${sql.identifier(table)}(${sql.join(columns, sql`,`)}) values(${sql.join(values, sql`,`)}) on conflict do nothing`,
    );
    const rows = await tx.execute(
      sql`select payload=${json(payload)}::jsonb as same from ${sql.identifier(table)} where workspace_id=${workspaceId} and ${sql.join(predicates, sql` and `)}`,
    );
    if (rows[0]?.same !== true)
      throw new Error("immutable wine snapshot conflict");
  }
  // Same row/mode as budget coordination. Call only after any listing/run locks;
  // registry writers acquire this before membership locks and never request listing/run locks.
  async function lockAuthorities() {
    scope.assertOpen();
    await tx.execute(
      sql`select id from workspaces where id=${workspaceId} for no key update`,
    );
  }
  return {
    async settleTerminalBudgets(runId) {
      scope.assertOpen();
      // Caller holds listing/run locks and fenced the operation before settlement.
      const runs = await tx.execute(
        sql`select execution_state, execution from listing_pipeline_runs where workspace_id=${workspaceId} and id=${runId} for update`,
      );
      if (
        !runs[0] ||
        ["queued", "running"].includes(String(runs[0].execution_state))
      )
        throw Error("terminal operation required for wine settlement");
      await tx.execute(
        sql`select id from workspaces where id=${workspaceId} for no key update`,
      );
      await tx.execute(
        sql`select id from ai_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${runId} for update`,
      );
      const calls = await tx.execute(
        sql`select count(*)::integer count from ai_runs where workspace_id=${workspaceId} and pipeline_run_id=${runId}`,
      );
      const go = createAiBudgetReservationRepository(tx, workspaceId, scope);
      if (calls[0]?.count === 0)
        await go.settle({
          pipelineRunId: runId,
          outcome: "settled",
          settledUsd: "0",
        });
      else await go.settleFromInvocations(runId);
      const execution = runs[0].execution as Record<string, unknown>;
      const budget = wineBudgetSnapshotSchema.parse(execution.wineBudget);
      if (budget.mode !== execution.wineMode)
        throw Error("invalid wine settlement mode");
      if (budget.mode === "copy" || budget.mode === "section") {
        if (budget.tavilyCredits !== 0)
          throw Error("invalid search-free budget");
      } else {
        await createSearchBudgetReservationRepository(
          tx,
          workspaceId,
          scope,
        ).settleFromCalls(runId);
      }
    },
    async claimStage(input) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`insert into wine_stages(workspace_id,run_id,stage,input_digest,dependency_digest) values(${workspaceId},${input.runId},${input.stage},${input.inputDigest},${input.dependencyDigest}) on conflict do nothing returning run_id`,
      );
      return !!rows[0];
    },
    async readStage(runId, stage) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select * from wine_stages where workspace_id=${workspaceId} and run_id=${runId} and stage=${stage}`,
      );
      const row = rows[0];
      return row
        ? {
            runId: String(row.run_id),
            stage: row.stage as WineStage,
            inputDigest: String(row.input_digest),
            dependencyDigest: String(row.dependency_digest),
            state: row.state as StageRecord["state"],
            output: row.output,
            updatedAt: new Date(row.updated_at as string).toISOString(),
          }
        : null;
    },
    async finishStage(input) {
      scope.assertOpen();
      if (input.state === "started") throw new Error("terminal stage required");
      const rows = await tx.execute(
        sql`update wine_stages set state=${input.state},output=${json(input.output)}::jsonb,updated_at=now() where workspace_id=${workspaceId} and run_id=${input.runId} and stage=${input.stage} and input_digest=${input.inputDigest} and dependency_digest=${input.dependencyDigest} and state='started' returning run_id`,
      );
      return !!rows[0];
    },
    async beginSearchCall(input) {
      scope.assertOpen();
      const reservation = await tx.execute(
        sql`select state,reserved_credits from search_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${input.runId} for update`,
      );
      if (reservation[0]?.state !== "held") return false;
      const rows =
        await tx.execute(sql`insert into wine_search_calls(workspace_id,run_id,slot,maximum_credits,request_digest)
    select ${workspaceId},${input.runId},${input.slot},${input.maximumCredits},${input.requestDigest}
    where (select coalesce(sum(maximum_credits),0) from wine_search_calls where workspace_id=${workspaceId} and run_id=${input.runId})+${input.maximumCredits}<=${reservation[0].reserved_credits}
    on conflict do nothing returning run_id`);
      return !!rows[0];
    },
    async readSearchCall(runId, slot) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select * from wine_search_calls where workspace_id=${workspaceId} and run_id=${runId} and slot=${slot}`,
      );
      const r = rows[0];
      return r
        ? {
            runId: String(r.run_id),
            slot: r.slot as SearchCall["slot"],
            maximumCredits: Number(r.maximum_credits),
            requestDigest: String(r.request_digest),
            credits: r.credits === null ? null : Number(r.credits),
            status: r.status as SearchCallRecord["status"],
            output:
              r.output === null ? null : wineSearchOutputSchema.parse(r.output),
            diagnostic:
              r.diagnostic === null
                ? null
                : wineSearchDiagnosticSchema.parse(r.diagnostic),
            updatedAt: new Date(r.updated_at as string).toISOString(),
          }
        : null;
    },
    async finishSearchCall(input) {
      scope.assertOpen();
      if (!["succeeded", "failed", "unknown"].includes(input.status))
        throw new Error("terminal search status required");
      if (
        input.status === "unknown"
          ? input.credits !== null
          : input.credits === null ||
            !Number.isSafeInteger(input.credits) ||
            input.credits < 0 ||
            input.credits > input.maximumCredits
      )
        throw new Error(
          "valid measured credits required for terminal search status",
        );
      const output =
        input.output === undefined
          ? null
          : wineSearchOutputSchema.parse(input.output);
      const diagnostic =
        input.diagnostic === undefined
          ? null
          : wineSearchDiagnosticSchema.parse(input.diagnostic);
      if (
        (output && input.status !== "succeeded") ||
        (diagnostic &&
          (input.status === "succeeded" ||
            diagnostic.reservedCredits !== input.maximumCredits)) ||
        (diagnostic?.code === "cost_discrepancy" && input.status !== "unknown")
      )
        throw new Error("invalid terminal search payload");
      const rows = await tx.execute(
        sql`update wine_search_calls set output=${output === null ? null : json(output)}::jsonb,diagnostic=${diagnostic === null ? null : json(diagnostic)}::jsonb,credits=${input.credits},status=${input.status},updated_at=now() where workspace_id=${workspaceId} and run_id=${input.runId} and slot=${input.slot} and request_digest=${input.requestDigest} and maximum_credits=${input.maximumCredits} and status='started' returning run_id`,
      );
      return !!rows[0];
    },
    async saveEvidence(runId, sources) {
      scope.assertOpen();
      const valid = sources.map((source) => evidenceSourceSchema.parse(source));
      for (const source of valid)
        await immutableInsert(
          "wine_evidence",
          { run_id: runId, source_id: source.id },
          source,
        );
    },
    async readEvidence(runId) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select payload from wine_evidence where workspace_id=${workspaceId} and run_id=${runId} order by source_id`,
      );
      return rows.map((row) => evidenceSourceSchema.parse(row.payload));
    },
    lockAuthorities,
    async recordReviewedAuthority(authenticatedActorId, authority) {
      scope.assertOpen();
      const parsed = wineSourceAuthoritySchema.parse(authority);
      await lockAuthorities();
      const membership = await tx.execute(
        sql`select role from memberships where workspace_id=${workspaceId} and user_id=${authenticatedActorId} for share`,
      );
      if (
        !["reviewer", "admin", "owner"].includes(String(membership[0]?.role)) ||
        parsed.verifierId !== authenticatedActorId
      )
        throw new Error("authorized reviewer required");
      await tx.execute(
        sql`insert into wine_source_authorities(workspace_id,reviewer_id,payload) values(${workspaceId},${authenticatedActorId},${json(parsed)}::jsonb)`,
      );
    },
    async readAuthorities() {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select payload from wine_source_authorities where workspace_id=${workspaceId} order by created_at,id`,
      );
      return rows.map((row) => wineSourceAuthoritySchema.parse(row.payload));
    },
    async saveTrustedContext(input) {
      const context = wineTrustedContextSchema.parse(input.context);
      await immutableInsert(
        "wine_trusted_contexts",
        {
          run_id: input.runId,
          context_key: input.contextKey,
          input_digest: input.inputDigest,
        },
        context,
      );
    },
    async readTrustedContext(runId, contextKey, inputDigest) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select payload from wine_trusted_contexts where workspace_id=${workspaceId} and run_id=${runId} and context_key=${contextKey} and input_digest=${inputDigest}`,
      );
      return rows[0] ? wineTrustedContextSchema.parse(rows[0].payload) : null;
    },
    async saveSections(input) {
      scope.assertOpen();
      const operation = await tx.execute(
        sql`select id from listing_pipeline_runs where workspace_id=${workspaceId} and id=${input.runId} and listing_id=${input.listingId}`,
      );
      if (!operation[0]) throw new Error("section run/listing mismatch");
      await immutableInsert(
        "wine_section_snapshots",
        {
          run_id: input.runId,
          listing_id: input.listingId,
          version_id: input.versionId,
        },
        { schemaVersion: 1, content: wineContentSchema.parse(input.content) },
      );
    },
    async readUsage(runId) {
      scope.assertOpen();
      const rows = await tx.execute(sql`select
        (select case when coalesce(bool_or(status='started' or estimated_cost_usd is null),false) then null else coalesce(sum(estimated_cost_usd),0)::numeric(18,6)::text end from ai_runs where workspace_id=${workspaceId} and pipeline_run_id=${runId}::uuid) as go_cost,
        (select case when coalesce(bool_or(status in ('started','unknown') or credits is null),false) then null else coalesce(sum(credits),0)::integer end from wine_search_calls where workspace_id=${workspaceId} and run_id=${runId}::uuid) as credits
        from listing_pipeline_runs where workspace_id=${workspaceId} and id=${runId}::uuid`);
      return {
        goEstimatedUsd:
          rows[0]?.go_cost == null ? null : String(rows[0].go_cost),
        tavilyCredits:
          rows[0]?.credits == null ? null : Number(rows[0].credits),
      };
    },
    async readVersionOrigin(listingId, versionId) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select v.id,v.sequence,v.pipeline_idempotency_key,v.content,s.run_id,s.payload from listing_versions v left join wine_section_snapshots s on s.workspace_id=v.workspace_id and s.listing_id=v.listing_id and s.version_id=v.id where v.workspace_id=${workspaceId} and v.listing_id=${listingId}::uuid and v.id=${versionId}::uuid`,
      );
      if (!rows.length) return null;
      if (rows.length !== 1) throw Error("ambiguous_wine_origin");
      const row = rows[0]!;
      const payload =
        row.payload === null
          ? null
          : z
              .object({
                schemaVersion: z.literal(1),
                content: wineContentSchema,
              })
              .strict()
              .parse(row.payload);
      return {
        workspaceId,
        listingId,
        versionId: String(row.id),
        sequence: Number(row.sequence),
        pipelineIdempotencyKey:
          row.pipeline_idempotency_key === null
            ? null
            : String(row.pipeline_idempotency_key),
        content: reviewableListingSchema.parse(row.content),
        runId: row.run_id === null ? null : String(row.run_id),
        sections: payload?.content ?? null,
      };
    },
    async readSections(runId, versionId) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select payload from wine_section_snapshots where workspace_id=${workspaceId} and run_id=${runId} and version_id=${versionId}`,
      );
      return rows[0]
        ? wineContentSchema.parse(
            (rows[0].payload as { content: unknown }).content,
          )
        : null;
    },
  };
}
