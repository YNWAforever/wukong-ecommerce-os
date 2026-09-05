import { createHash } from "node:crypto";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
import postgres from "postgres";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import {
  BULK_FORM_COLUMNS,
  compareFreshExport,
  hashBulkFormHeaderContract,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";
import { createDatabase } from "../index.js";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL,
  appUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !appUrl)
  throw new Error("Explicit isolated test database URLs required");
const adminTarget = new URL(adminUrl),
  appTarget = new URL(appUrl);
if (
  adminTarget.hostname !== appTarget.hostname ||
  adminTarget.port !== appTarget.port ||
  adminTarget.pathname !== appTarget.pathname
)
  throw new Error(
    "Test admin/runtime URLs must address the same isolated database",
  );
const admin = postgres(adminUrl, {
  max: 1,
  onnotice: () => undefined,
  prepare: false,
});
const app = postgres(appUrl, { max: 1, prepare: false });
const db = createDatabase(appUrl, { migrationUrl: adminUrl });
const spec = SHOPLINE_BULK_FORM_SPEC_VERSION,
  header = hashBulkFormHeaderContract();
const listingId = "11111111-1111-4111-8111-111111111111",
  versionId = "22222222-2222-4222-8222-222222222222";
const sheet = [
  BULK_FORM_COLUMNS.map((c) => c.en),
  BULK_FORM_COLUMNS.map((c) => c.zh),
  BULK_FORM_COLUMNS.map((c) => (c.key === "productId" ? "001" : "")),
];
const artifactBytes = writeBulkFormWorkbook(sheet);
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
const comparison = compareFreshExport({
  delivered: sheet,
  supplied: sheet,
  productIds: ["001"],
});
async function fixture(workspaceId = "ws_verifications") {
  const manifest = [{ listingId, versionId, outcome: "included" as const }];
  const provenance = {
    identityVersion: 1,
    workspaceId,
    freshnessAttested: true,
    headerContractSha256: header,
    specVersion: spec,
    rowOrder: [listingId],
    manifest,
    evidence: [
      {
        listingId,
        versionId,
        approvalReceiptId: "receipt",
        sourceSnapshotId: "source",
        confirmationVersionId: versionId,
        headerContractSha256: header,
        specVersion: spec,
        confirmationRevision: 1,
        sourceImportId: "import",
        rowDigest: "c".repeat(64),
        remoteProductId: "001",
        connectionId: "store",
      },
    ],
  };
  const attempt = await db.forWorkspace(workspaceId, async (r) => {
    const a = await r.exportAttempts.ensure({
      idempotencyKey: "export",
      requestedBy: "user",
      manifest,
      rowCount: 1,
      specVersion: spec,
      artifactSha256: artifactSha256,
      provenance,
    });
    return r.exportAttempts.markReady({
      id: a.id,
      artifactSha256: artifactSha256,
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    exportAttemptId: attempt.id,
    artifactSha256: artifactSha256,
    suppliedSha256: "b".repeat(64),
    merchantAttestedExportAt: new Date(),
    connectionId: "store",
    policyVersion: comparison.policyVersion,
    filename: "synthetic.xlsx",
    recordedBy: "user",
    provenance,
    comparison,
  };
}
const ensure = (
  input: Awaited<ReturnType<typeof fixture>>,
  ws = "ws_verifications",
) => db.forWorkspace(ws, (r) => r.exportVerifications.ensure(input));
beforeAll(async () => {
  await db.migrate();
  const [role] =
    await app`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
});
beforeEach(async () => {
  await admin.unsafe("TRUNCATE workspaces,users CASCADE");
  await admin`insert into workspaces(id,name,profile) values('ws_verifications','Synthetic','{}'),('other','Other','{}')`;
});
afterAll(async () => {
  await db.close();
  await app.end();
  await admin.end();
});
describe("coherent export evidence snapshot", () => {
  it("reads the exact selected comparison, scopes foreign access, and counts complete receipt revisions", async () => {
    const input = await fixture();
    const first = await ensure(input);
    await ensure({ ...input, suppliedSha256: "d".repeat(64) });
    const snapshot = await db.forWorkspace("ws_verifications", (r) =>
      r.exportEvidence.getSnapshot(input.exportAttemptId, first.id),
    );
    expect(snapshot.comparison?.id).toBe(first.id);
    expect(snapshot.attempt?.id).toBe(input.exportAttemptId);
    expect(snapshot.asOf).toBeInstanceOf(Date);
    expect(snapshot.receiptCount).toBe(0);
    expect(
      (
        await db.forWorkspace("other", (r) =>
          r.exportEvidence.getSnapshot(input.exportAttemptId, first.id),
        )
      ).attempt,
    ).toBeNull();
    expect(
      (
        await db.forWorkspace("ws_verifications", (r) =>
          r.exportEvidence.getSnapshot(
            input.exportAttemptId,
            "33333333-3333-4333-8333-333333333333",
          ),
        )
      ).comparison,
    ).toBeNull();
  });
});

it("retains complete corrections, excludes unrelated modes/members, and returns overflow sentinel", async () => {
  const input = await fixture(),
    record = await ensure(input);
  await admin`insert into listing_drafts(id,workspace_id) values(${listingId},'ws_verifications')`;
  await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${versionId},'ws_verifications',${listingId},1,'{}','user')`;
  const create = (data: any) =>
    db.forWorkspace("ws_verifications", (r) => r.importResults.create(data));
  const first = await create({
    mode: "export",
    listingId,
    versionId,
    exportAttemptId: input.exportAttemptId,
    idempotencyKey: "first",
    outcome: "rejected",
    rejectReason: "bad",
    recordedBy: "actor",
  });
  const second = await create({
    mode: "export",
    listingId,
    versionId,
    exportAttemptId: input.exportAttemptId,
    idempotencyKey: "second",
    outcome: "accepted",
    rejectReason: null,
    recordedBy: "actor",
    supersedesResultId: first.id,
    correctionReason: "correction",
  });
  await create({
    mode: "historical_manual",
    listingId,
    exportAttemptId: null,
    idempotencyKey: "historical",
    outcome: "accepted",
    rejectReason: null,
    recordedBy: "actor",
  });
  const get = () =>
    db.forWorkspace("ws_verifications", (r) =>
      r.exportEvidence.getSnapshot(input.exportAttemptId, record.id),
    );
  const result = await get();
  expect(result.receiptCount).toBe(2);
  expect(result.receipts.map((r) => r.id)).toEqual([first.id, second.id]);
  await admin`with revisions as materialized (select n,gen_random_uuid() id from generate_series(3,1002) n) insert into import_results(id,workspace_id,listing_id,export_attempt_id,version_id,mode,revision,outcome,reject_reason,recorded_by,idempotency_key,supersedes_result_id,correction_reason) select id,'ws_verifications',${listingId}::uuid,${input.exportAttemptId}::uuid,${versionId}::uuid,'export',n,'accepted',null,'actor','overflow-'||n,coalesce(lag(id) over(order by n),${second.id}::uuid),'synthetic correction' from revisions order by n`;
  const overflow = await get();
  expect(overflow.receiptCount).toBe(1001);
  expect(overflow.receipts).toHaveLength(1001);
});

it("keeps one MVCC snapshot when a receipt commits while the packet statement waits", async () => {
  const input = await fixture(),
    record = await ensure(input);
  await admin`insert into listing_drafts(id,workspace_id) values(${listingId},'ws_verifications')`;
  await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${versionId},'ws_verifications',${listingId},1,'{}','user')`;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { sql } = await import("drizzle-orm");
  const { createExportEvidenceRepository } =
    await import("./export-evidence.js");
  const monitor = postgres(adminUrl!, { max: 1, prepare: false });
  let pending: Promise<unknown> | undefined,
    statements = 0;
  try {
    await admin.begin(async (writer) => {
      await writer`select pg_advisory_xact_lock(99881234)`;
      pending = drizzle(app).transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.workspace_id','ws_verifications',true)`,
        );
        // Test-only statement envelope: the original production SQL remains intact and executes once.
        // Its MVCC snapshot is established before the barrier; the writer commits before the evidence reads proceed.
        const wrapped = {
          execute: (statement: Parameters<typeof tx.execute>[0]) => {
            statements++;
            return tx.execute(
              sql`with barrier as materialized (select pg_advisory_xact_lock(99881234)) select packet.* from barrier cross join lateral (${statement}) packet`,
            );
          },
        };
        return createExportEvidenceRepository(
          wrapped as any,
          "ws_verifications",
          { assertOpen() {} },
        ).getSnapshot(input.exportAttemptId, record.id);
      });
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows =
          await monitor`select 1 from pg_stat_activity where wait_event='advisory' and query like '%selected_attempt%'`;
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await writer`insert into import_results(workspace_id,listing_id,export_attempt_id,version_id,mode,revision,outcome,recorded_by,idempotency_key) values('ws_verifications',${listingId},${input.exportAttemptId},${versionId},'export',1,'accepted','actor','concurrent')`;
    });
    const before = (await pending) as {
      receiptCount: number;
      receipts: unknown[];
      comparison: { id: string };
    };
    expect(statements).toBe(1);
    expect(before.receiptCount).toBe(0);
    expect(before.receipts).toEqual([]);
    expect(before.comparison.id).toBe(record.id);
    const after = await db.forWorkspace("ws_verifications", (r) =>
      r.exportEvidence.getSnapshot(input.exportAttemptId, record.id),
    );
    expect(after.receiptCount).toBe(1);
    expect(after.receipts).toHaveLength(1);
  } finally {
    if (pending) await pending.catch(() => undefined);
    await monitor.end();
  }
});

it("rolls back a prepared download audit on writer failure and creates no workflow state", async () => {
  const input = await fixture(),
    record = await ensure(input);
  const { createExportEvidenceService } =
    await import("../../../../apps/web/lib/export-evidence-service");
  const getAssetStore = () => ({ readObject: async () => artifactBytes });
  const service = createExportEvidenceService({
    getDatabase: () => db,
    getAssetStore,
  });
  const packetInput = {
    workspaceId: "ws_verifications",
    exportAttemptId: input.exportAttemptId,
    comparisonId: record.id,
  };
  const preview = await service.preview(packetInput);
  const failing = createExportEvidenceService({
    getAssetStore,
    getDatabase: () => ({
      forWorkspace: (workspaceId: string, work: any) =>
        db.forWorkspace(workspaceId, (r) =>
          work({
            ...r,
            audit: {
              write: async (event: any) => {
                await r.audit.write(event);
                throw new Error("private database detail");
              },
            },
          }),
        ),
    }),
  });
  await expect(
    failing.download({
      ...packetInput,
      actorId: "actor",
      expectedSnapshotSha256: preview.snapshotSha256,
    }),
  ).rejects.toMatchObject({ code: "evidence_packet_unavailable", status: 503 });
  const [before] =
    await admin`select count(*)::int as n from audit_events where action='shopline.export_evidence_packet_downloaded'`;
  expect(before!.n).toBe(0);
  await service.download({
    ...packetInput,
    actorId: "actor",
    expectedSnapshotSha256: preview.snapshotSha256,
  });
  const [after] =
    await admin`select (select count(*)::int from audit_events where action='shopline.export_evidence_packet_downloaded') audits,(select count(*)::int from import_results) receipts,(select count(*)::int from export_verifications) comparisons,(select count(*)::int from export_attempts) attempts`;
  expect(after).toEqual({
    audits: 1,
    receipts: 0,
    comparisons: 1,
    attempts: 1,
  });
});
