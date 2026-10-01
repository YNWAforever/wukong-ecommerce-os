import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyWorkingListing } from "@wukong/core";
import { createDatabase } from "../client.js";
import { QualityContentAssessmentError } from "./quality-projection.js";
import { computeCurrentContentGaps } from "../quality-content-assessor.js";

const enabled = process.env.WUKONG_OPAK_INTEGRATION === "1";
const appUrl = process.env.TEST_DATABASE_URL,
  adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (enabled) {
  for (const [value, role] of [
    [appUrl, "wukong_app"],
    [adminUrl, "wukong"],
  ] as const) {
    if (!value) throw Error("Dedicated quality database URLs required");
    const target = new URL(value);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      target.pathname !== "/opak_fixes_quality_20261001" ||
      target.username !== role
    )
      throw Error(
        "Quality integration requires its exact dedicated loopback database and roles",
      );
  }
  if (new URL(appUrl!).host !== new URL(adminUrl!).host)
    throw Error("Quality integration database hosts must match");
}
const clean = () => ({
  ...emptyWorkingListing(),
  title: { en: "Synthetic Estate", "zh-Hant": "示範酒莊" },
  description: {
    en: "Synthetic product description",
    "zh-Hant": "示範產品描述",
  },
  seo: {
    title: { en: "Shop estate wine", "zh-Hant": "選購示範葡萄酒" },
    description: {
      en: "Explore this synthetic estate wine",
      "zh-Hant": "探索示範酒款",
    },
  },
  tags: ["wine", "estate"],
});
describe.skipIf(!enabled)(
  "revision-aware quality projection on dedicated actual RLS",
  { timeout: 30000 },
  () => {
    const database = enabled
      ? createDatabase(appUrl!, { migrationUrl: adminUrl!, maxConnections: 4 })
      : null!;
    const admin = enabled
      ? postgres(adminUrl!, {
          max: 2,
          prepare: false,
          onnotice: () => undefined,
        })
      : null!;
    const app = enabled
      ? postgres(appUrl!, { max: 2, prepare: false, onnotice: () => undefined })
      : null!;
    beforeAll(async () => {
      await database.migrate();
      const [role] =
        await app`select not rolsuper and not rolbypassrls safe from pg_roles where rolname=current_user`;
      expect(role?.safe).toBe(true);
    }, 120000);
    afterAll(async () => {
      await database.close();
      await admin.end();
      await app.end();
    });
    async function workspace() {
      const id = `ws_quality_${randomUUID()}`;
      await admin`insert into workspaces(id,name,profile) values(${id},'Synthetic quality',${admin.json({ name: "Synthetic quality", currency: "HKD", locales: ["en", "zh-Hant"], tone: "plain", claimPolicy: [], requiredFields: [], brandBackgroundColor: null })})`;
      return id;
    }
    async function drafts(ws: string, count: number, initialized = true) {
      return database.forWorkspace(ws, async (r) => {
        const ids: string[] = [];
        for (let index = 0; index < count; index++) {
          const d = await r.listings.create({ target: "shopline" });
          if (initialized)
            await r.listingInputs.initialize(
              {
                listingId: d.id,
                actorId: "synthetic",
                workingContent: clean(),
              },
              { workspaceId: ws, actorId: "synthetic", entityId: d.id },
              r.audit,
            );
          ids.push(d.id);
        }
        return ids;
      });
    }
    const read = (ws: string) =>
      database.forWorkspace(ws, (r) => r.qualityProjection.read());
    const reconcile = (ws: string, limit = 25) =>
      database.forWorkspace(ws, (r) =>
        r.qualityProjection.reconcile(computeCurrentContentGaps, { limit }),
      );
    const cost = (ws: string) =>
      database.forWorkspace(ws, (r) => r.aiRuns.summarizeOwnedCostMetadata());
    async function generation(ws: string, id: string) {
      const [row] =
        await admin`select requested_generation,applied_generation,state from listing_quality_assessments where workspace_id=${ws} and listing_id=${id}`;
      return row;
    }
    async function run(ws: string, id: string) {
      const runId = randomUUID();
      await admin`insert into listing_pipeline_runs(id,workspace_id,listing_id,active_version_sequence,idempotency_key,status) values(${runId},${ws},${id},0,${randomUUID()},'started')`;
      return runId;
    }
    async function ai(
      ws: string,
      id: string,
      value: number | null,
      status = "started",
      pipeline: string | null = null,
      stage: string | null = null,
    ) {
      const aiId = randomUUID();
      await admin`insert into ai_runs(id,workspace_id,listing_id,task,idempotency_key,provider,model,status,input,latency_ms,estimated_cost_usd,pipeline_run_id,stage,call_ordinal,usage_certainty) values(${aiId},${ws},${id},${pipeline || value !== null ? "extract" : "verify"},${randomUUID()},'synthetic','synthetic',${status},'{}',0,${value},${pipeline},${stage},${pipeline ? 1 : null},'unknown')`;
      return aiId;
    }
    it("initializes all28 identities, assesses25, includes all pending, then warms without reassessing content", async () => {
      const ws = await workspace();
      await drafts(ws, 28);
      expect(await read(ws)).toMatchObject({
        totalListings: 28,
        cleanCount: 0,
        projection: { pendingCount: 28, stale: true },
      });
      const assessor = vi.fn(computeCurrentContentGaps);
      const first = await database.forWorkspace(ws, (r) =>
        r.qualityProjection.reconcile(assessor, { limit: 25 }),
      );
      expect(assessor).toHaveBeenCalledTimes(25);
      expect(first).toMatchObject({
        totalAssessed: 25,
        cleanCount: 25,
        projection: { state: "pending", pendingCount: 3, stale: true },
      });
      expect(await reconcile(ws)).toMatchObject({
        cleanCount: 28,
        projection: { state: "ready", pendingCount: 0, stale: false },
      });
      assessor.mockClear();
      await database.forWorkspace(ws, (r) =>
        r.qualityProjection.reconcile(assessor),
      );
      expect(assessor).not.toHaveBeenCalled();
    });
    it("invalidates clean immediately on a human revision and replays save/reconciliation exactly once", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1);
      await reconcile(ws);
      const input = {
        listingId: id!,
        actorId: "synthetic",
        expectedInputRevision: 1,
        baseVersionId: null,
        operationKey: randomUUID(),
        requestDigest: "a".repeat(64),
        changes: [
          {
            field: "title.zh-Hant" as const,
            value: "Synthetic Estate",
            locked: true,
          },
        ],
      };
      const save = () =>
        database.forWorkspace(ws, (r) =>
          r.listingInputs.save(
            input,
            { workspaceId: ws, actorId: "synthetic", entityId: id! },
            r.audit,
          ),
        );
      await save();
      expect(await read(ws)).toMatchObject({
        cleanCount: 0,
        totalAssessed: 0,
        projection: { pendingCount: 1, stale: true },
      });
      expect(await reconcile(ws)).toMatchObject({
        cleanCount: 0,
        hasGapsCount: 1,
        gapCounts: { untranslatedName: 1 },
      });
      const before = await generation(ws, id!);
      expect((await save()).replayed).toBe(true);
      await reconcile(ws);
      expect(await generation(ws, id!)).toEqual(before);
      expect((await read(ws)).hasGapsCount).toBe(1);
    });
    it("covers legacy mutable active content, replacement/status and malformed selected input without fake clean", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1, false),
        v = randomUUID();
      await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${v},${ws},${id!},1,${admin.json(clean())},'synthetic')`;
      await admin`update listing_drafts set active_version_id=${v} where workspace_id=${ws} and id=${id!}`;
      expect((await reconcile(ws)).cleanCount).toBe(1);
      await admin`update listing_versions set content=${admin.json({ ...clean(), title: { en: "Synthetic Estate", "zh-Hant": "Synthetic Estate" } })} where workspace_id=${ws} and id=${v}`;
      expect((await read(ws)).cleanCount).toBe(0);
      expect((await reconcile(ws)).hasGapsCount).toBe(1);
      await admin`update listing_drafts set status='failed' where workspace_id=${ws} and id=${id!}`;
      expect((await read(ws)).projection.pendingCount).toBe(1);
      await reconcile(ws);
      const v2 = randomUUID();
      await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${v2},${ws},${id!},2,'{}','synthetic')`;
      await admin`update listing_drafts set active_version_id=${v2} where workspace_id=${ws} and id=${id!}`;
      expect(await reconcile(ws)).toMatchObject({
        cleanCount: 0,
        invalidCurrentContent: 1,
        unassessableActiveVersion: 1,
      });
      await admin`insert into listing_input_revisions(workspace_id,listing_id,revision,working_content,field_states,input_digest,actor_id) values(${ws},${id!},1,'{}','{}',${"b".repeat(64)},'synthetic')`;
      await admin`update listing_drafts set input_revision=1,active_version_id=null where workspace_id=${ws} and id=${id!}`;
      expect(await reconcile(ws)).toMatchObject({
        invalidCurrentContent: 1,
        cleanCount: 0,
        unassessableActiveVersion: 0,
      });
      await expect(
        admin`update listing_input_revisions set working_content='{}' where workspace_id=${ws} and listing_id=${id!}`,
      ).rejects.toThrow();
      expect((await read(ws)).projection.stale).toBe(false);
    });
    it("invalidates import bindings, stores deterministic latest fence and covers unlink/delete/no-op", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1),
        connection = randomUUID(),
        one = randomUUID(),
        two = randomUUID();
      await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values(${connection},${ws},'synthetic.example','synthetic-unused')`;
      for (const product of [one, two])
        await admin`insert into platform_products(id,workspace_id,connection_id,remote_product_id,sku,listing_id,origin,spec_version,raw_row,facts_prefill,content_digest,updated_at) values(${product},${ws},${connection},${product},'synthetic',${id!},'import','synthetic','{}','{}',${"c".repeat(64)},'2026-10-01T00:00:00Z')`;
      await reconcile(ws);
      const latest = [one, two].sort().at(-1)!;
      const [fence] =
        await admin`select source_fence from listing_quality_assessments where workspace_id=${ws} and listing_id=${id!}`;
      expect(fence?.source_fence.sourceBinding.productId).toBe(latest);
      const before = await generation(ws, id!);
      await admin`update platform_products set content_digest=content_digest,updated_at=updated_at where workspace_id=${ws} and id=${latest}`;
      expect(await generation(ws, id!)).toEqual(before);
      await admin`update platform_products set content_digest=${"d".repeat(64)} where workspace_id=${ws} and id=${latest}`;
      expect((await read(ws)).cleanCount).toBe(0);
      await reconcile(ws);
      await admin`update platform_products set listing_id=null where workspace_id=${ws} and id=${latest}`;
      expect((await read(ws)).projection.pendingCount).toBe(1);
      await reconcile(ws);
      await admin`delete from platform_products where workspace_id=${ws} and listing_id=${id!}`;
      expect((await read(ws)).projection.pendingCount).toBe(1);
      await reconcile(ws);
    });
    it("retains deletion tombstone until atomic subtraction and rolls back denied initialized deletion", async () => {
      const ws = await workspace(),
        [legacy] = await drafts(ws, 1, false);
      await reconcile(ws);
      await admin`delete from listing_drafts where workspace_id=${ws} and id=${legacy!}`;
      expect(await read(ws)).toMatchObject({
        totalListings: 0,
        missingCurrentContent: 0,
        cleanCount: 0,
        projection: { pendingCount: 1, stale: true },
      });
      expect(await reconcile(ws)).toMatchObject({
        totalListings: 0,
        projection: { state: "ready", pendingCount: 0 },
      });
      const [id] = await drafts(ws, 1);
      await reconcile(ws);
      const before = await generation(ws, id!);
      await expect(
        admin`delete from listing_drafts where workspace_id=${ws} and id=${id!}`,
      ).rejects.toThrow();
      expect(await generation(ws, id!)).toEqual(before);
      expect((await read(ws)).cleanCount).toBe(1);
    });
    it("uses exact LIVE NULL population/known subtotal before reconciliation with bounded safe references", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1);
      const ids = [];
      for (let index = 0; index < 27; index++)
        ids.push(
          await ai(
            ws,
            id!,
            null,
            index % 2 ? "failed" : "started",
            null,
            index === 26 ? "private-arbitrary-stage" : "extract",
          ),
        );
      const costRun = await run(ws, id!);
      await ai(ws, id!, 2.5, "failed", costRun, "extract");
      await ai(ws, id!, 0, "succeeded");
      const result = await cost(ws);
      expect(result).toMatchObject({
        knownCostUsd: 2.5,
        unknownCostRunCount: 27,
        unknownCostReferences: { total: 27, limit: 25, hasMore: true },
      });
      expect(result.unknownCostReferences.items).toHaveLength(25);
      expect(
        result.unknownCostReferences.items.find(
          (item) => item.aiRunId === ids.at(-1),
        )?.stage,
      ).toBeNull();
      expect(JSON.stringify(result)).not.toContain("private-arbitrary-stage");
      await admin`update ai_runs set estimated_cost_usd=0 where workspace_id=${ws} and id=${ids[0]!}`;
      expect((await cost(ws)).unknownCostRunCount).toBe(26);
      await admin`update ai_runs set estimated_cost_usd=null where workspace_id=${ws} and estimated_cost_usd=2.5`;
      expect(await cost(ws)).toMatchObject({
        knownCostUsd: 0,
        unknownCostRunCount: 27,
      });
    });
    it("retains real owned run/batch lineage on archive, hides foreign pointers and leaves legacy explicitly unbound", async () => {
      const ws = await workspace(),
        other = await workspace(),
        [id] = await drafts(ws, 1),
        [foreign] = await drafts(other, 1);
      const ownedRun = await run(ws, id!),
        foreignRun = await run(other, foreign!),
        batch = randomUUID();
      await admin`insert into enrichment_batches(id,workspace_id,label,budget_usd,wave_size,created_by) values(${batch},${ws},'Synthetic',1,1,'synthetic')`;
      await admin`insert into enrichment_batch_items(workspace_id,batch_id,listing_id,pipeline_run_id,input_revision) values(${ws},${batch},${id!},${ownedRun},1)`;
      const ownedAi = await ai(ws, id!, null, "failed", ownedRun, "extract"),
        foreignAi = await ai(ws, id!, null, "started", foreignRun, "extract"),
        legacy = await ai(ws, id!, null, "failed");
      const first = await cost(ws);
      expect(
        first.unknownCostReferences.items.find(
          (item) => item.aiRunId === ownedAi,
        ),
      ).toMatchObject({ pipelineRunId: ownedRun, batchId: batch });
      expect(
        first.unknownCostReferences.items.find(
          (item) => item.aiRunId === foreignAi,
        ),
      ).toMatchObject({ pipelineRunId: null, batchId: null });
      expect(
        first.unknownCostReferences.items.find(
          (item) => item.aiRunId === legacy,
        ),
      ).toMatchObject({ pipelineRunId: null, batchId: null, stage: null });
      await admin`update enrichment_batches set archived_at=now() where workspace_id=${ws} and id=${batch}`;
      expect(
        (await cost(ws)).unknownCostReferences.items.find(
          (item) => item.aiRunId === ownedAi,
        )?.batchId,
      ).toBe(batch);
      await admin`update enrichment_batches set archived_at=null where workspace_id=${ws} and id=${batch}`;
      expect((await cost(ws)).unknownCostRunCount).toBe(3);
    });
    it("applies physical ledger begin/finalize replay once and persists an observed cost snapshot", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1),
        pipeline = await run(ws, id!);
      const begin = () =>
        database.forWorkspace(ws, (r) =>
          r.aiRuns.beginInvocation({
            listingId: id!,
            pipelineRunId: pipeline,
            task: "extract",
            stage: "extract",
            callOrdinal: 1,
            provider: "synthetic",
            model: "synthetic",
            promptVersion: "synthetic",
          }),
        );
      expect((await begin()).claimed).toBe(true);
      await reconcile(ws);
      const ready = await generation(ws, id!);
      expect((await begin()).claimed).toBe(false);
      expect(await generation(ws, id!)).toEqual(ready);
      const finalize = () =>
        database.forWorkspace(ws, (r) =>
          r.aiRuns.finalizeInvocation({
            pipelineRunId: pipeline,
            stage: "extract",
            callOrdinal: 1,
            status: "failed",
            inputTokens: null,
            outputTokens: null,
            latencyMs: 1,
            estimatedCostUsd: "0.125000",
            usageCertainty: "estimated",
          }),
        );
      expect(await finalize()).toBe(true);
      await reconcile(ws);
      const done = await generation(ws, id!);
      expect(await finalize()).toBe(false);
      expect(await generation(ws, id!)).toEqual(done);
      const live = await cost(ws);
      await database.forWorkspace(ws, (r) =>
        r.qualityProjection.recordCostSnapshot({
          knownCostUsd: live.knownCostUsd,
          unknownCostRunCount: live.unknownCostRunCount,
          asOf: live.unknownCostReferences.asOf,
        }),
      );
      const [snapshot] =
        await admin`select known_cost_usd,unknown_cost_run_count,cost_as_of from workspace_quality_summaries where workspace_id=${ws}`;
      expect(Number(snapshot?.known_cost_usd)).toBe(0.125);
      expect(Number(snapshot?.unknown_cost_run_count)).toBe(0);
      expect(snapshot?.cost_as_of).toBeTruthy();
    });
    it("persists only classified content failures, excludes old clean and recovers on new generation", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1);
      await reconcile(ws);
      await admin`update listing_drafts set note='synthetic changed' where workspace_id=${ws} and id=${id!}`;
      const failed = await database.forWorkspace(ws, (r) =>
        r.qualityProjection.reconcile(() => {
          throw new QualityContentAssessmentError();
        }),
      );
      expect(failed).toMatchObject({
        cleanCount: 0,
        totalAssessed: 0,
        projection: {
          state: "failed",
          failedCount: 1,
          pendingCount: 0,
          stale: true,
        },
      });
      expect((await reconcile(ws)).projection.failedCount).toBe(1);
      await admin`update listing_drafts set note='synthetic retry' where workspace_id=${ws} and id=${id!}`;
      expect((await reconcile(ws)).cleanCount).toBe(1);
    });
    it("rolls back already-applied row work on unexpected assessment/global SQL faults", async () => {
      const ws = await workspace();
      await drafts(ws, 2);
      let calls = 0;
      await expect(
        database.forWorkspace(ws, (r) =>
          r.qualityProjection.reconcile((item) => {
            if (++calls === 2) throw Error("synthetic global fault");
            return computeCurrentContentGaps(item);
          }),
        ),
      ).rejects.toThrow("synthetic global fault");
      expect(await read(ws)).toMatchObject({
        cleanCount: 0,
        projection: { pendingCount: 2, failedCount: 0 },
      });
      await expect(
        database.forWorkspace(ws, async (r) => {
          await r.qualityProjection.reconcile(computeCurrentContentGaps);
          throw Object.assign(Error("synthetic SQL schema fault"), {
            code: "42P01",
          });
        }),
      ).rejects.toMatchObject({ code: "42P01" });
      expect((await read(ws)).projection.pendingCount).toBe(2);
      expect((await reconcile(ws)).cleanCount).toBe(2);
    });
    it("counts all work while concurrent SKIP LOCKED reconcilers apply each contribution once", async () => {
      const ws = await workspace();
      await drafts(ws, 40);
      await Promise.all([reconcile(ws), reconcile(ws)]);
      expect(await read(ws)).toMatchObject({
        cleanCount: 40,
        totalAssessed: 40,
        projection: { pendingCount: 0, stale: false },
      });
      await Promise.all([reconcile(ws), reconcile(ws)]);
      expect((await read(ws)).cleanCount).toBe(40);
    });
    it("fences concurrent source mutation: writer invalidates applied old observation before publishing new content", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1, false),
        version = randomUUID();
      await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${version},${ws},${id!},1,${admin.json(clean())},'synthetic')`;
      await admin`update listing_drafts set active_version_id=${version} where workspace_id=${ws} and id=${id!}`;
      let writer: Promise<unknown> | undefined,
        finished = false;
      await database.forWorkspace(ws, async (r) => {
        const result = await r.qualityProjection.reconcile((item) => {
          writer = Promise.resolve(
            admin`update listing_versions set content=${admin.json({ ...clean(), title: { en: "Synthetic Estate", "zh-Hant": "Synthetic Estate" } })} where workspace_id=${ws} and id=${version}`,
          ).then(() => {
            finished = true;
          });
          return computeCurrentContentGaps(item);
        });
        expect(result.cleanCount).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(finished).toBe(false);
      });
      await writer;
      expect(await read(ws)).toMatchObject({
        cleanCount: 0,
        projection: { pendingCount: 1, stale: true },
      });
      expect((await reconcile(ws)).hasGapsCount).toBe(1);
    });
    it("preserves ready projection on normal migration replay and fails closed on missing identity coverage", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1);
      await reconcile(ws);
      const before = await generation(ws, id!);
      await database.migrate();
      expect(await generation(ws, id!)).toEqual(before);
      expect((await read(ws)).cleanCount).toBe(1);
      await admin`delete from listing_quality_assessments where workspace_id=${ws} and listing_id=${id!}`;
      await expect(read(ws)).rejects.toThrow("source coverage invariant");
      await database.migrate();
      await expect(read(ws)).rejects.toThrow("source coverage invariant");
    }, 120000);
    it("fails closed for corrupt ready-generation mismatch rather than claiming ready", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1);
      await reconcile(ws);
      await admin`update listing_quality_assessments set requested_generation=requested_generation+1 where workspace_id=${ws} and listing_id=${id!}`;
      await expect(read(ws)).rejects.toThrow("ready generation invariant");
      await expect(reconcile(ws)).rejects.toThrow("ready generation invariant");
    });
    it("does not fabricate zero from malformed saved scalar counts", async () => {
      const ws = await workspace();
      await drafts(ws, 1);
      await reconcile(ws);
      await admin`update workspace_quality_summaries set counts='{}' where workspace_id=${ws}`;
      await expect(read(ws)).rejects.toThrow("count invariant");
    });
    it("seeds preexisting unassessed identity metadata once and safely cascades a legacy workspace", async () => {
      const ws = await workspace();
      await drafts(ws, 2, false);
      await admin`delete from listing_quality_assessments where workspace_id=${ws}`;
      await admin`update workspace_quality_summaries set initialized=false where workspace_id=${ws}`;
      await database.migrate();
      expect(await read(ws)).toMatchObject({
        totalListings: 2,
        cleanCount: 0,
        projection: { pendingCount: 2 },
      });
      await reconcile(ws);
      await database.migrate();
      expect(await read(ws)).toMatchObject({
        missingCurrentContent: 2,
        projection: { state: "ready" },
      });
      await admin`delete from workspaces where id=${ws}`;
      expect(
        await admin`select listing_id from listing_quality_assessments where workspace_id=${ws}`,
      ).toHaveLength(0);
      expect(
        await admin`select workspace_id from workspace_quality_summaries where workspace_id=${ws}`,
      ).toHaveLength(0);
    }, 120000);
    it("bubbles actual global permission/schema faults without mutating pending projection", async () => {
      const ws = await workspace();
      await drafts(ws, 1);
      try {
        await admin`revoke select on workspace_quality_summaries from wukong_app`;
        await expect(read(ws)).rejects.toThrow();
      } finally {
        await admin`grant select on workspace_quality_summaries to wukong_app`;
      }
      expect((await read(ws)).projection).toMatchObject({
        pendingCount: 1,
        failedCount: 0,
      });
      try {
        await admin`alter table workspace_quality_summaries rename to quality_summary_schema_fault_fixture`;
        await expect(reconcile(ws)).rejects.toThrow();
      } finally {
        await admin`alter table quality_summary_schema_fault_fixture rename to workspace_quality_summaries`;
      }
      expect(await read(ws)).toMatchObject({
        cleanCount: 0,
        projection: { pendingCount: 1, failedCount: 0 },
      });
      expect((await reconcile(ws)).cleanCount).toBe(1);
    });
    async function cli(ws: string, batches = 1, budget = 10000) {
      const entry = fileURLToPath(
        new URL("../cli/quality-backfill.ts", import.meta.url),
      );
      return new Promise<{
        code: number | string;
        body: Record<string, unknown>;
      }>((resolve, reject) => {
        execFile(
          process.execPath,
          [
            "--import",
            "tsx",
            entry,
            "--workspace-id",
            ws,
            "--max-batches",
            String(batches),
            "--time-budget-ms",
            String(budget),
          ],
          {
            env: { ...process.env, DATABASE_URL: appUrl! },
            timeout: 15000,
            maxBuffer: 65536,
          },
          (error, stdout) => {
            try {
              resolve({
                code: (error as { code?: number | string } | null)?.code ?? 0,
                body: JSON.parse(stdout.trim()),
              });
            } catch {
              reject(Error("quality CLI did not return controlled metadata"));
            }
          },
        );
      });
    }
    it("actual CLI bounds25-row batches, reports resumable metadata and resumes to ready", async () => {
      const ws = await workspace();
      await drafts(ws, 28, false);
      const first = await cli(ws);
      expect(first.code).toBe(2);
      expect(first.body).toMatchObject({
        completed: false,
        batches: 1,
        pendingCount: 3,
        totalAssessed: 0,
      });
      expect(first.body).not.toHaveProperty("content");
      expect(first.body).not.toHaveProperty("workspaceId");
      const next = await cli(ws);
      expect(next.code).toBe(0);
      expect(next.body).toMatchObject({
        completed: true,
        batches: 1,
        pendingCount: 0,
        unknownCostRunCount: 0,
      });
      expect((await read(ws)).missingCurrentContent).toBe(28);
    });
    it("actual CLI deadline cancels in-flight blocked work, rolls back and leaves no owned transaction", async () => {
      const ws = await workspace(),
        [id] = await drafts(ws, 1);
      let release!: () => void, locked!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lockPromise = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const blocker = admin.begin(async (tx) => {
        await tx`select workspace_id from workspace_quality_summaries where workspace_id=${ws} for update`;
        locked();
        await releasePromise;
      });
      await lockPromise;
      let result;
      try {
        result = await cli(ws, 1, 1000);
      } finally {
        release();
        await blocker;
      }
      expect(result.code).toBe(2);
      expect(result.body).toMatchObject({
        event: "quality_backfill",
        outcome: "partial",
        reason: "deadline_exhausted",
        completed: false,
        lastCommitted: null,
      });
      expect(await generation(ws, id!)).toMatchObject({
        state: "pending",
        applied_generation: "0",
      });
      expect(await read(ws)).toMatchObject({
        cleanCount: 0,
        projection: { pendingCount: 1, failedCount: 0 },
      });
      const [activity] =
        await admin`select count(*)::int active from pg_stat_activity where datname=current_database() and usename='wukong_app' and state='idle in transaction'`;
      expect(activity?.active).toBe(0);
      expect((await reconcile(ws)).cleanCount).toBe(1);
    });
    it("enforces unscoped and foreign RLS plus composite owned live identities", async () => {
      const ws = await workspace(),
        other = await workspace(),
        [id] = await drafts(ws, 1),
        [foreign] = await drafts(other, 1);
      await reconcile(ws);
      await reconcile(other);
      expect(
        await app`select workspace_id from workspace_quality_summaries`,
      ).toHaveLength(0);
      expect(
        await app`select listing_id from listing_quality_assessments`,
      ).toHaveLength(0);
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id',${ws},true)`;
          const rows =
            await tx`select workspace_id from listing_quality_assessments`;
          expect(rows.every((row) => row.workspace_id === ws)).toBe(true);
          await tx`insert into listing_quality_assessments(workspace_id,assessment_version,listing_id,live_listing_id) values(${ws},'opak-current-content-v1',${foreign!},${foreign!})`;
        }),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id',${ws},true)`;
          await tx`update workspace_quality_summaries set counts='{}' where workspace_id=${other}`;
          await tx`insert into workspace_quality_summaries(workspace_id,assessment_version) values(${other},'opak-current-content-v1')`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await generation(ws, id!)).toBeTruthy();
      expect((await read(other)).cleanCount).toBe(1);
    });
  },
);
