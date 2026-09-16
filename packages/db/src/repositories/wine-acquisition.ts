import { sql } from "drizzle-orm";
import { z } from "zod";
import { evidenceSourceSchema, type EvidenceSource } from "@wukong/core";
import {
  wineDocumentRequestSchema,
  wineDocumentResultSchema,
  wineAcquisitionPolicySchema,
  type WineDocumentRequest,
  type WineDocumentResult,
} from "@wukong/jobs";
import type {
  WorkspaceScope,
  WorkspaceTransaction,
  Database,
} from "../client.js";
export type WineDocumentContext = {
  workspaceId: string;
  runId: string;
  source: EvidenceSource;
  inputRevision: number;
  currentInputRevision: number;
  currentRunId: string | null;
  flowVersion: string;
  executionState: string;
  acceptedAt: string;
  deadlineAt: string;
  allowedDomains: string[];
};
export type WineDocumentClaim =
  | { state: "stale" }
  | { state: "unknown" }
  | { state: "completed"; result: WineDocumentResult }
  | { state: "claimed"; context: WineDocumentContext };
const cacheKeySchema = z.strictObject({
  identityKey: z.string().min(1).max(500),
  policyVersion: z.string().min(1).max(200),
  rulesVersion: z.string().min(1).max(200),
});
export type WineCacheKey = z.infer<typeof cacheKeySchema>;
const cachePayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sources: z.array(evidenceSourceSchema).min(1).max(20),
  })
  .superRefine((v, c) => {
    for (const s of v.sources)
      if (
        s.kind !== "web" ||
        !["snippet", "document"].includes(s.contentScope) ||
        !s.excerpt.trim() ||
        s.excerpt.length > 16000 ||
        s.title.length > 500 ||
        !s.url ||
        s.url.length > 2048 ||
        new URL(s.url).hostname !== s.domain ||
        new URL(s.url).username ||
        new URL(s.url).password
      )
        c.addIssue({
          code: "custom",
          message: "Cache requires bounded successful web evidence",
        });
    if (JSON.stringify(v).length > 200000)
      c.addIssue({ code: "custom", message: "Cache snapshot too large" });
  });
export type WineCacheSnapshot = WineCacheKey & {
  snapshotId: string;
  runId: string;
  capturedAt: string;
  payload: z.infer<typeof cachePayloadSchema>;
};
function cacheRecord(row: Record<string, unknown>): WineCacheSnapshot {
  return {
    snapshotId: String(row.snapshot_id),
    runId: String(row.run_id),
    identityKey: String(row.identity_key),
    policyVersion: String(row.policy_version),
    rulesVersion: String(row.rules_version),
    capturedAt: new Date(row.captured_at as string).toISOString(),
    payload: cachePayloadSchema.parse(row.payload),
  };
}
export function createWineAcquisitionRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  async function context(
    raw: WineDocumentRequest,
  ): Promise<WineDocumentContext | null> {
    scope.assertOpen();
    const input = wineDocumentRequestSchema.parse(raw);
    if (input.workspaceId !== workspaceId) return null;
    // Lock listing before run, matching operation acceptance/commit ordering. DB clock is read AFTER locks.
    const listing = await tx.execute(
      sql`select d.* from listing_drafts d join listing_pipeline_runs r on r.workspace_id=d.workspace_id and r.listing_id=d.id where r.workspace_id=${workspaceId} and r.id=${input.runId} for update of d`,
    );
    if (!listing[0]) return null;
    const runs = await tx.execute(
      sql`select * from listing_pipeline_runs where workspace_id=${workspaceId} and id=${input.runId} for update`,
    );
    const r = runs[0]!,
      d = listing[0];
    const now = await tx.execute(sql`select clock_timestamp() as time`);
    const execution = r.execution as Record<string, unknown>;
    const policy = wineAcquisitionPolicySchema.safeParse(
      execution?.wineAcquisition,
    );
    if (
      !policy.success ||
      execution.schemaVersion !== 1 ||
      execution.flowVersion !== "wine-enrichment-v1" ||
      !["queued", "running"].includes(String(r.execution_state)) ||
      r.input_revision !== input.inputRevision ||
      d.input_revision !== input.inputRevision ||
      d.current_run_id !== input.runId
    )
      return null;
    const acceptedAt = new Date(r.created_at as string).toISOString(),
      deadlineAt = policy.data.deadlineAt;
    const start = Date.parse(acceptedAt),
      end = Date.parse(deadlineAt),
      current = new Date(now[0]!.time as string).getTime();
    if (!(
      end > start &&
      end - start <= 900000 &&
      current >= start &&
      current < end
    ))
      return null;
    const sources = await tx.execute(
      sql`select payload from wine_evidence where workspace_id=${workspaceId} and run_id=${input.runId} and source_id=${input.sourceId}`,
    );
    const parsed = evidenceSourceSchema.safeParse(sources[0]?.payload);
    if (
      !parsed.success ||
      parsed.data.id !== input.sourceId ||
      parsed.data.kind !== "web" ||
      !parsed.data.url
    )
      return null;
    const url = new URL(parsed.data.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !policy.data.allowedDomains.includes(url.hostname)
    )
      return null;
    return {
      workspaceId,
      runId: input.runId,
      source: parsed.data,
      inputRevision: input.inputRevision,
      currentInputRevision: Number(d.input_revision),
      currentRunId: String(d.current_run_id),
      flowVersion: String(execution.flowVersion),
      executionState: String(r.execution_state),
      acceptedAt,
      deadlineAt,
      allowedDomains: policy.data.allowedDomains,
    };
  }
  function boundResult(
    input: WineDocumentRequest,
    raw: unknown,
    ctx: WineDocumentContext,
  ) {
    const parsed = wineDocumentResultSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data;
    if (
      value.workspaceId !== input.workspaceId ||
      value.runId !== input.runId ||
      value.sourceId !== input.sourceId ||
      value.kind !== input.kind ||
      value.inputRevision !== input.inputRevision
    )
      return null;
    const url = new URL(value.url);
    if (
      url.username ||
      url.password ||
      url.port ||
      !ctx.allowedDomains.includes(url.hostname)
    )
      return null;
    if (
      Date.parse(value.capturedAt) < Date.parse(ctx.acceptedAt) ||
      Date.parse(value.capturedAt) >= Date.parse(ctx.deadlineAt)
    )
      return null;
    return value;
  }
  return {
    async claimDocument(
      input: WineDocumentRequest,
    ): Promise<WineDocumentClaim> {
      const ctx = await context(input);
      if (!ctx) return { state: "stale" };
      const inserted = await tx.execute(
        sql`insert into wine_document_requests(workspace_id,run_id,source_id,kind,input_revision) select ${workspaceId},${input.runId},${input.sourceId},${input.kind},${input.inputRevision} where clock_timestamp()<${ctx.deadlineAt}::timestamptz on conflict do nothing returning run_id`,
      );
      if (inserted[0]) return { state: "claimed", context: ctx };
      const rows = await tx.execute(
        sql`select * from wine_document_requests where workspace_id=${workspaceId} and run_id=${input.runId} and source_id=${input.sourceId} and kind=${input.kind}`,
      );
      const row = rows[0];
      if (!row || row.input_revision !== input.inputRevision)
        return { state: "stale" };
      if (row.state === "started") return { state: "unknown" };
      const result = boundResult(input, row.result, ctx);
      return result ? { state: "completed", result } : { state: "unknown" };
    },
    async finishDocument(
      input: WineDocumentRequest,
      raw: WineDocumentResult,
    ): Promise<boolean> {
      const ctx = await context(input);
      if (!ctx) return false;
      const result = boundResult(input, raw, ctx);
      if (!result) return false;
      const rows = await tx.execute(
        sql`update wine_document_requests set state='completed',result=${JSON.stringify(result)}::jsonb,updated_at=clock_timestamp() where workspace_id=${workspaceId} and run_id=${input.runId} and source_id=${input.sourceId} and kind=${input.kind} and input_revision=${input.inputRevision} and state='started' and clock_timestamp()<${ctx.deadlineAt}::timestamptz and ${result.capturedAt}::timestamptz<=clock_timestamp() returning run_id`,
      );
      return !!rows[0];
    },
    async saveCacheSnapshot(
      input: WineCacheKey & {
        snapshotId: string;
        runId: string;
        sourceIds: string[];
      },
    ): Promise<WineCacheSnapshot> {
      scope.assertOpen();
      const key = cacheKeySchema.parse({
        identityKey: input.identityKey,
        policyVersion: input.policyVersion,
        rulesVersion: input.rulesVersion,
      });
      z.uuid().parse(input.snapshotId);
      z.uuid().parse(input.runId);
      z.array(z.uuid()).min(1).max(20).parse(input.sourceIds);
      if (new Set(input.sourceIds).size !== input.sourceIds.length)
        throw new Error("duplicate cache source");
      // Serialize cache publication to prevent two refreshes from laundering old source IDs.
      await tx.execute(
        sql`select id from workspaces where id=${workspaceId} for update`,
      );
      const reused = await tx.execute(
        sql`select snapshot_id from wine_evidence_cache c where c.workspace_id=${workspaceId} and c.snapshot_id<>${input.snapshotId} and exists(select 1 from jsonb_array_elements(c.payload->'sources') s where s->>'id' in (${sql.join(
          input.sourceIds.map((id) => sql`${id}`),
          sql`,`,
        )})) limit 1`,
      );
      if (reused[0])
        throw new Error("cache refresh requires fresh evidence IDs");
      const rows = await tx.execute(
        sql`select payload from wine_evidence where workspace_id=${workspaceId} and run_id=${input.runId} and source_id in (${sql.join(
          input.sourceIds.map((id) => sql`${id}`),
          sql`,`,
        )}) order by source_id`,
      );
      if (rows.length !== input.sourceIds.length)
        throw new Error("missing cache evidence");
      const payload = cachePayloadSchema.parse({
        schemaVersion: 1,
        sources: rows.map((row) => row.payload),
      });
      await tx.execute(
        sql`insert into wine_evidence_cache(workspace_id,snapshot_id,run_id,identity_key,policy_version,rules_version,payload) values(${workspaceId},${input.snapshotId},${input.runId},${key.identityKey},${key.policyVersion},${key.rulesVersion},${JSON.stringify(payload)}::jsonb) on conflict do nothing`,
      );
      const saved = await tx.execute(
        sql`select *,payload=${JSON.stringify(payload)}::jsonb as same from wine_evidence_cache where workspace_id=${workspaceId} and snapshot_id=${input.snapshotId}`,
      );
      const row = saved[0];
      if (
        !row ||
        !row.same ||
        row.run_id !== input.runId ||
        row.identity_key !== key.identityKey ||
        row.policy_version !== key.policyVersion ||
        row.rules_version !== key.rulesVersion
      )
        throw new Error("immutable cache snapshot conflict");
      return cacheRecord(row);
    },
    async readCacheSnapshot(
      raw: WineCacheKey,
    ): Promise<WineCacheSnapshot | null> {
      scope.assertOpen();
      const key = cacheKeySchema.parse(raw);
      const rows = await tx.execute(
        sql`select * from wine_evidence_cache where workspace_id=${workspaceId} and identity_key=${key.identityKey} and policy_version=${key.policyVersion} and rules_version=${key.rulesVersion} and captured_at<=clock_timestamp() and captured_at>clock_timestamp()-interval '7 days' order by captured_at desc,snapshot_id desc limit 1`,
      );
      return rows[0] ? cacheRecord(rows[0]) : null;
    },
  };
}
export type WineAcquisitionRepository = ReturnType<
  typeof createWineAcquisitionRepository
>;
/** A service port must await the OUTER workspace transaction: only then is admission durable.
 * Ignore callback wall-clock input; PostgreSQL owns authorization time. No I/O inside callbacks. */
export function createWineDocumentStore(db: Pick<Database, "forWorkspace">) {
  return {
    claim(
      input: WineDocumentRequest,
      _now: string,
    ): Promise<WineDocumentClaim> {
      return db.forWorkspace(input.workspaceId, (r) =>
        r.wineAcquisition.claimDocument(input),
      );
    },
    finish(
      input: WineDocumentRequest,
      result: WineDocumentResult,
      _now: string,
    ): Promise<boolean> {
      return db.forWorkspace(input.workspaceId, (r) =>
        r.wineAcquisition.finishDocument(input, result),
      );
    },
  };
}
