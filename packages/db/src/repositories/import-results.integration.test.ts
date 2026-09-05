import postgres from "postgres";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { createDatabase } from "../index.js";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !appUrl)
  throw new Error(
    "Explicit isolated TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL required",
  );
const admin = postgres(adminUrl, {
  max: 1,
  onnotice: () => undefined,
  prepare: false,
});
const db = createDatabase(appUrl, { migrationUrl: adminUrl });
const listingId = "11111111-1111-4111-8111-111111111111",
  versionId = "22222222-2222-4222-8222-222222222222",
  otherVersion = "33333333-3333-4333-8333-333333333333";
const manifest = [{ listingId, versionId, outcome: "included" as const }];
const provenance = {
  identityVersion: 1,
  workspaceId: "ws_results",
  freshnessAttested: true,
  headerContractSha256: "b".repeat(64),
  specVersion: "spec",
  rowOrder: [listingId],
  manifest,
  evidence: [
    {
      listingId,
      versionId,
      approvalReceiptId: "receipt",
      sourceSnapshotId: "source",
      confirmationVersionId: versionId,
      headerContractSha256: "b".repeat(64),
      specVersion: "spec",
      confirmationRevision: 1,
      sourceImportId: "import",
      rowDigest: "c".repeat(64),
      remoteProductId: "remote",
      connectionId: "connection",
    },
  ],
};
const base = {
  mode: "export" as const,
  listingId,
  versionId,
  idempotencyKey: "report",
  outcome: "accepted" as const,
  rejectReason: null,
  recordedBy: "user",
};
async function attempt(overrides: Record<string, unknown> = {}) {
  return db.forWorkspace("ws_results", async (r) => {
    const a = await r.exportAttempts.ensure({
      idempotencyKey: "export",
      requestedBy: "user",
      manifest,
      rowCount: 1,
      specVersion: "spec",
      provenance,
      artifactSha256: "a".repeat(64),
      ...overrides,
    });
    return r.exportAttempts.markReady({
      id: a.id,
      artifactSha256: "a".repeat(64),
    });
  });
}
const create = (input: any) =>
  db.forWorkspace("ws_results", (r) => r.importResults.create(input));
beforeAll(async () => {
  await db.migrate();
});
beforeEach(async () => {
  await admin.unsafe("TRUNCATE workspaces,users CASCADE");
  await admin`insert into workspaces(id,name,profile) values('ws_results','Results','{}'),('other','Other','{}')`;
  await admin`insert into listing_drafts(id,workspace_id) values(${listingId},'ws_results')`;
  await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${versionId},'ws_results',${listingId},1,'{}','user'),(${otherVersion},'ws_results',${listingId},2,'{}','user')`;
});
afterAll(async () => {
  await db.close();
  await admin.end();
});
describe("trusted results repository", () => {
  it("rejects nonincluded and no-op members of same-workspace attempts", async () => {
    const a = await attempt({
      manifest: [{ listingId, versionId, outcome: "excluded_no_op" }],
    });
    await expect(create({ ...base, exportAttemptId: a.id })).rejects.toThrow();
  });
  it("binds exported version even when a newer version exists; wrong exported version rejects", async () => {
    const a = await attempt();
    await expect(
      create({ ...base, versionId: otherVersion, exportAttemptId: a.id }),
    ).rejects.toThrow("export_version_mismatch");
    expect((await create({ ...base, exportAttemptId: a.id })).versionId).toBe(
      versionId,
    );
  });
  it("returns one receipt for simultaneous exact retries; changed input conflicts", async () => {
    const a = await attempt();
    const input = { ...base, exportAttemptId: a.id };
    const rows = await Promise.all([create(input), create(input)]);
    expect(rows[0].id).toBe(rows[1].id);
    expect(rows.filter((r) => r.wasCreated)).toHaveLength(1);
    await expect(
      create({ ...input, outcome: "rejected", rejectReason: "bad" }),
    ).rejects.toThrow("idempotency_conflict");
  });
  it("preserves ordered corrections and rejects stale observed heads under concurrency", async () => {
    const a = await attempt();
    const first = await create({ ...base, exportAttemptId: a.id });
    const correction = {
      ...base,
      exportAttemptId: a.id,
      supersedesResultId: first.id,
      correctionReason: "Corrected from SHOPLINE screen",
      outcome: "rejected",
      rejectReason: "Invalid SKU",
    };
    const settled = await Promise.allSettled([
      create({ ...correction, idempotencyKey: "c1" }),
      create({ ...correction, idempotencyKey: "c2" }),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.forWorkspace("ws_results", (r) =>
      r.importResults.listForExportAttempts([a.id]),
    );
    expect(rows.map((r) => r.revision)).toEqual([2, 1]);
    expect(rows[0]?.supersedesResultId).toBe(first.id);
  });
  it("rejects concurrent initial reports with different keys", async () => {
    const a = await attempt();
    const settled = await Promise.allSettled([
      create({ ...base, exportAttemptId: a.id }),
      create({ ...base, idempotencyKey: "other", exportAttemptId: a.id }),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("keeps historical manual reports unlinked and outside attempt totals", async () => {
    const a = await attempt();
    await expect(
      create({ ...base, mode: "historical_manual", exportAttemptId: a.id }),
    ).rejects.toThrow();
    await create({
      ...base,
      mode: "historical_manual",
      versionId: null,
      exportAttemptId: null,
    });
    expect(
      await db.forWorkspace("ws_results", (r) =>
        r.importResults.listForExportAttempts([a.id]),
      ),
    ).toEqual([]);
  });
  it("keeps old valid reports despite more than 100 newer unrelated reports", async () => {
    const a = await attempt();
    const row = await create({ ...base, exportAttemptId: a.id });
    let latest: string | undefined;
    for (let i = 0; i < 101; i++) {
      const r = await create({
        ...base,
        mode: "historical_manual",
        versionId: null,
        exportAttemptId: null,
        idempotencyKey: "manual" + i,
        ...(latest
          ? {
              supersedesResultId: latest,
              correctionReason: "synthetic correction",
            }
          : {}),
      });
      latest = r.id;
    }
    expect(
      (
        await db.forWorkspace("ws_results", (r) =>
          r.importResults.listForWorkspace(),
        )
      ).some((r) => r.id === row.id),
    ).toBe(false);
    expect(
      (
        await db.forWorkspace("ws_results", (r) =>
          r.importResults.listForExportAttempts([a.id]),
        )
      )[0]?.id,
    ).toBe(row.id);
  });
  it("does not expose foreign attempts or their receipts", async () => {
    const a = await attempt();
    await create({ ...base, exportAttemptId: a.id });
    expect(
      await db.forWorkspace("other", (r) =>
        r.importResults.listForExportAttempts([a.id]),
      ),
    ).toEqual([]);
    expect(
      await db.forWorkspace("other", (r) => r.exportAttempts.getById(a.id)),
    ).toBeNull();
  });
  it("rejects non-ready and incomplete provenance attempts", async () => {
    const a = await db.forWorkspace("ws_results", (r) =>
      r.exportAttempts.ensure({
        idempotencyKey: "pending",
        requestedBy: "user",
        manifest,
        rowCount: 1,
        specVersion: "spec",
        provenance,
        artifactSha256: "a".repeat(64),
      }),
    );
    await expect(create({ ...base, exportAttemptId: a.id })).rejects.toThrow(
      "export_artifact_not_ready",
    );
    await db.forWorkspace("ws_results", (r) =>
      r.exportAttempts.markReady({ id: a.id, artifactSha256: "a".repeat(64) }),
    );
    await admin`update export_attempts set provenance='{"identityVersion":1}' where id=${a.id}`;
    await expect(create({ ...base, exportAttemptId: a.id })).rejects.toThrow(
      "export_provenance_incomplete",
    );
  });
  it("enforces RLS and append-only permissions at SQL boundary", async () => {
    const a = await attempt();
    const row = await create({ ...base, exportAttemptId: a.id });
    const app = postgres(appUrl!, { max: 1 });
    try {
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id','ws_results',true)`;
          await tx`update import_results set outcome='rejected' where id=${row.id}`;
        }),
      ).rejects.toThrow();
    } finally {
      await app.end();
    }
  });
});
