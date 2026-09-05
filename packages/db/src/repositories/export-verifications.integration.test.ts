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
      artifactSha256: "a".repeat(64),
      provenance,
    });
    return r.exportAttempts.markReady({
      id: a.id,
      artifactSha256: "a".repeat(64),
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    exportAttemptId: attempt.id,
    artifactSha256: "a".repeat(64),
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
describe("durable snapshot comparisons", () => {
  it("idempotent concurrent retries write exactly one evidence row and audit; first filename/actor retained", async () => {
    const input = await fixture();
    const results = await Promise.all([ensure(input), ensure(input)]);
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(results.filter((r) => r.wasCreated)).toHaveLength(1);
    const retry = await ensure({
      ...input,
      filename: "renamed.xlsx",
      recordedBy: "another",
    });
    expect(retry).toMatchObject({
      filename: "synthetic.xlsx",
      recordedBy: "user",
      wasCreated: false,
    });
    const [counts] =
      await admin`select (select count(*)::int from export_verifications) as evidence,(select count(*)::int from audit_events where action='shopline.export_snapshot_compared') as audits`;
    expect(counts).toEqual({ evidence: 1, audits: 1 });
  });
  it("appends new snapshots and pages exact summary total and scoped detail", async () => {
    const input = await fixture();
    const one = await ensure(input);
    const two = await ensure({ ...input, suppliedSha256: "d".repeat(64) });
    const page = await db.forWorkspace("ws_verifications", (r) =>
      r.exportVerifications.listForAttempt(input.exportAttemptId, 1, 1),
    );
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).toBe(two.id);
    expect(page.items[0]).not.toHaveProperty("provenance");
    expect(page.items[0]!.comparison).not.toHaveProperty("products");
    expect(
      await db.forWorkspace("ws_verifications", (r) =>
        r.exportVerifications.getForAttempt(input.exportAttemptId, one.id),
      ),
    ).toMatchObject({ comparison });
    expect(
      await db.forWorkspace("other", (r) =>
        r.exportVerifications.getForAttempt(input.exportAttemptId, one.id),
      ),
    ).toBeNull();
    expect(
      await db.forWorkspace("ws_verifications", (r) =>
        r.exportVerifications.getForAttempt(
          "33333333-3333-4333-8333-333333333333",
          one.id,
        ),
      ),
    ).toBeNull();
    expect(
      (
        await db.forWorkspace("ws_verifications", (r) =>
          r.exportVerifications.listForAttempt(input.exportAttemptId, 3, 1),
        )
      ).items,
    ).toEqual([]);
  });
  it("enforces RLS for direct runtime reads/inserts and same-workspace attempt binding", async () => {
    const input = await fixture();
    await ensure(input);
    expect(await app`select id from export_verifications`).toHaveLength(0);
    await expect(ensure(input, "other")).rejects.toThrow(
      "export_attempt_not_found",
    );
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id','other',true)`;
        await tx.unsafe(
          "insert into export_verifications select * from export_verifications",
        );
        await tx`insert into export_verifications(workspace_id,export_attempt_id,identity_key,artifact_sha256,supplied_sha256,merchant_attested_export_at,connection_id,policy_version,filename,recorded_by,provenance,comparison) values('ws_verifications',${input.exportAttemptId},${"f".repeat(64)},${input.artifactSha256},${input.suppliedSha256},${input.merchantAttestedExportAt},'store','fresh-export-v1','x.xlsx','user',${JSON.stringify(input.provenance)}::jsonb,${JSON.stringify(comparison)}::jsonb)`;
      }),
    ).rejects.toThrow();
  });
  it("composite FK rejects a foreign attempt even if privileged insertion bypasses the guard", async () => {
    const input = await fixture();
    const record = await ensure(input);
    await expect(
      admin.begin(async (tx) => {
        await tx.unsafe(
          "ALTER TABLE export_verifications DISABLE TRIGGER export_verifications_insert_guard",
        );
        await tx`insert into export_verifications(workspace_id,export_attempt_id,identity_key,artifact_sha256,supplied_sha256,merchant_attested_export_at,connection_id,policy_version,filename,recorded_by,provenance,comparison) select 'other',export_attempt_id,identity_key,artifact_sha256,supplied_sha256,merchant_attested_export_at,connection_id,policy_version,filename,recorded_by,provenance,comparison from export_verifications where id=${record.id}`;
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects mutation after UPDATE/DELETE privilege regrant", async () => {
    const record = await ensure(await fixture());
    await admin.unsafe(
      "GRANT UPDATE,DELETE ON export_verifications TO wukong_app",
    );
    for (const verb of [
      "UPDATE export_verifications SET filename='changed.xlsx'",
      "DELETE FROM export_verifications",
    ])
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id','ws_verifications',true)`;
          await tx.unsafe(verb + " WHERE id='" + record.id + "'");
        }),
      ).rejects.toThrow("append only");
    await admin.unsafe(
      "REVOKE UPDATE,DELETE ON export_verifications FROM wukong_app",
    );
  });
  it("rolls back evidence when its content-free audit fails", async () => {
    const input = await fixture();
    await admin.unsafe(
      "CREATE FUNCTION task8_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='shopline.export_snapshot_compared' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER task8_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION task8_fail_audit();",
    );
    try {
      await expect(ensure(input)).rejects.toMatchObject({
        cause: { message: "synthetic audit failure" },
      });
      expect(await admin`select id from export_verifications`).toHaveLength(0);
    } finally {
      await admin.unsafe(
        "DROP TRIGGER task8_fail_audit ON audit_events; DROP FUNCTION task8_fail_audit()",
      );
    }
  });
  it("revalidates immutable digest, connection, membership and chronology at persistence boundary", async () => {
    const input = await fixture();
    for (const overrides of [
      { artifactSha256: "e".repeat(64) },
      { connectionId: "other" },
      { merchantAttestedExportAt: new Date("2000-01-01") },
      { comparison: { ...comparison, products: [] } },
    ])
      await expect(ensure({ ...input, ...overrides })).rejects.toThrow();
    expect(await admin`select id from export_verifications`).toHaveLength(0);
  });
  it("replays every migration without altering existing comparison or audit", async () => {
    const input = await fixture();
    const row = await ensure(input);
    await db.migrate();
    const { wasCreated, ...stored } = row;
    expect(
      await db.forWorkspace("ws_verifications", (r) =>
        r.exportVerifications.getForAttempt(input.exportAttemptId, row.id),
      ),
    ).toEqual(stored);
  });
});

it("refuses oversized full evidence envelopes before any insert", async () => {
  const input = await fixture();
  await expect(
    ensure({ ...input, recordedBy: "x".repeat(2 * 1024 * 1024) }),
  ).rejects.toMatchObject({ code: "comparison_input_too_large", status: 413 });
  expect(await admin`select id from export_verifications`).toHaveLength(0);
});
