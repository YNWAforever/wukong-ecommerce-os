import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../client.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const admin = postgres(adminUrl, { max: 3, onnotice: () => undefined });
const app = postgres(appUrl, { max: 3, onnotice: () => undefined });
const database = createDatabase(appUrl, { migrationUrl: adminUrl });
const ws = "task3_binding_test";
const other = "task3_binding_other";
const listingId = randomUUID(),
  otherListingId = randomUUID(),
  sameTenantOtherListingId = randomUUID();
const versionId = randomUUID(),
  secondVersionId = randomUUID(),
  otherVersionId = randomUUID();
const connectionId = randomUUID(),
  otherConnectionId = randomUUID(),
  sourceImportId = randomUUID();
const snapshotInput = {
  listingId,
  connectionId,
  sourceImportId,
  remoteProductId: "synthetic-product",
  sourceRowDigest: "a".repeat(64),
  rawRow: { productId: "synthetic-product", price: "100" },
  specVersion: "synthetic-v1",
  headerContractSha256: "b".repeat(64),
};
let snapshotId: string;

beforeAll(async () => {
  await database.migrate();
  await admin.unsafe("TRUNCATE workspaces, users CASCADE");
  await admin`insert into workspaces(id,name,profile) values (${ws},${ws},'{}'),(${other},${other},'{}')`;
  await admin`insert into listing_drafts(id,workspace_id,target) values (${listingId},${ws},'shopline'),(${sameTenantOtherListingId},${ws},'shopline'),(${otherListingId},${other},'shopline')`;
  await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${versionId},${ws},${listingId},1,'{}','test'),(${secondVersionId},${ws},${sameTenantOtherListingId},1,'{}','test'),(${otherVersionId},${other},${otherListingId},1,'{}','test')`;
  await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values (${connectionId},${ws},'synthetic.example','synthetic'),(${otherConnectionId},${other},'other.example','synthetic')`;
  await admin`insert into source_imports(id,workspace_id,connection_id,filename,workbook_sha256,header_contract_sha256,sheet_name,row_count,merchant_attested_export_at,importer_id,spec_version) values (${sourceImportId},${ws},${connectionId},'synthetic.xlsx',${"c".repeat(64)},${"b".repeat(64)},'Products',1,now(),'test','synthetic-v1')`;
});
afterAll(async () => {
  await database.close();
  await app.end();
  await admin.end();
});

function recordInput(revision = 0) {
  return {
    listingId,
    versionId,
    sourceSnapshotId: snapshotId,
    confirmationVersionId: versionId,
    confirmationRevision: revision,
    approvedBy: "test",
  };
}

describe("durable source and approval binding", () => {
  it("leaves old approvals untrusted and exports historical", async () => {
    expect(
      await database.forWorkspace(ws, (r) =>
        r.approvalReceipts.getByVersionId(versionId),
      ),
    ).toBeNull();
    await admin`insert into export_attempts(workspace_id,idempotency_key,requested_by,manifest,row_count,spec_version) values (${ws},'legacy','test','[]',0,'legacy')`;
    const [row] =
      await admin`select provenance,artifact_status,artifact_sha256 from export_attempts where idempotency_key='legacy'`;
    expect(row).toEqual({
      provenance: null,
      artifact_status: null,
      artifact_sha256: null,
    });
  });
  it("preserves immutable rows and reads only inside their workspace", async () => {
    const rows = await database.forWorkspace(ws, (r) =>
      r.sourceRows.createMany([snapshotInput]),
    );
    snapshotId = rows[0]!.id;
    expect(
      await database.forWorkspace(ws, (r) =>
        r.sourceRows.getForProduct(snapshotInput),
      ),
    ).toMatchObject(snapshotInput);
    expect(
      await database.forWorkspace(other, (r) =>
        r.sourceRows.getForProduct(snapshotInput),
      ),
    ).toBeNull();
    await expect(
      database.forWorkspace(ws, (r) =>
        r.sourceRows.createMany([
          { ...snapshotInput, rawRow: { price: "999" } },
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`update source_row_snapshots set raw_row='{}' where id=${snapshotId}`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("returns the exact receipt for two same-transaction receipts and retries", async () => {
    await database.forWorkspace(ws, async (r) => {
      const first = await r.approvalReceipts.record(recordInput(0));
      const second = await r.approvalReceipts.record(recordInput(1));
      const retry = await r.approvalReceipts.record(recordInput(0));
      expect(first.wasCreated).toBe(true);
      expect(second.wasCreated).toBe(true);
      expect(second.confirmationRevision).toBe(1);
      expect(retry.id).toBe(first.id);
      expect(retry.confirmationRevision).toBe(0);
      expect(retry.wasCreated).toBe(false);
    });
    expect(
      await database.forWorkspace(other, (r) =>
        r.approvalReceipts.getByVersionId(versionId),
      ),
    ).toBeNull();
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`delete from bulk_update_approval_receipts where version_id=${versionId}`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("orders receipts by insertion even when transaction timestamps run backwards", async () => {
    const [earlier, later] = await database.forWorkspace(ws, async (r) => {
      const earlier = await r.approvalReceipts.record(recordInput(10));
      const later = await r.approvalReceipts.record(recordInput(11));
      return [earlier, later] as const;
    });
    // Two inserts in one transaction share now(). Model an earlier-started
    // transaction acquiring the review lock last by reversing their timestamps.
    await admin`update bulk_update_approval_receipts set created_at='2099-01-01' where id=${earlier.id}`;
    await admin`update bulk_update_approval_receipts set created_at='2000-01-01' where id=${later.id}`;
    const latest = await database.forWorkspace(ws, (r) =>
      r.approvalReceipts.getByVersionId(versionId),
    );
    expect(latest?.id).toBe(later.id);
    expect(latest?.confirmationRevision).toBe(11);
  });
  it("rejects cross-workspace and wrong-listing relationships", async () => {
    await expect(
      database.forWorkspace(other, (r) =>
        r.sourceRows.createMany([
          {
            ...snapshotInput,
            listingId: otherListingId,
            remoteProductId: "cross-workspace",
          },
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      database.forWorkspace(ws, (r) =>
        r.sourceRows.createMany([
          {
            ...snapshotInput,
            connectionId: otherConnectionId,
            remoteProductId: "cross-connection",
          },
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      database.forWorkspace(ws, (r) =>
        r.approvalReceipts.record({
          ...recordInput(2),
          confirmationVersionId: secondVersionId,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      database.forWorkspace(ws, (r) =>
        r.approvalReceipts.record({
          ...recordInput(2),
          versionId: otherVersionId,
        }),
      ),
    ).rejects.toThrow();
  });
  it("rejects invalid artifact state/hash and retains tenant FORCE RLS", async () => {
    await expect(
      admin`update export_attempts set artifact_status='published' where idempotency_key='legacy'`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin`update export_attempts set artifact_sha256='bad' where idempotency_key='legacy'`,
    ).rejects.toMatchObject({ code: "23514" });
    const rows =
      await admin`select relrowsecurity,relforcerowsecurity from pg_class where relname in ('source_row_snapshots','bulk_update_approval_receipts')`;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(
      true,
    );
  });
});

describe("review row lock serialization", () => {
  for (const operation of ["flag", "confirmation", "source"] as const) {
    it(`blocks concurrent ${operation} mutations until review lock releases`, async () => {
      if (operation === "source")
        await admin`insert into platform_products(workspace_id,connection_id,remote_product_id,origin,listing_id) values (${ws},${connectionId},'lock-product','import',${listingId}) on conflict do nothing`;
      let release!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      let locked!: () => void;
      const acquired = new Promise<void>((r) => {
        locked = r;
      });
      const holder = database.forWorkspace(ws, async (r) => {
        await r.listings.lockReviewState(listingId);
        locked();
        await released;
      });
      await acquired;
      let pid!: number;
      let started!: () => void;
      const ready = new Promise<void>((r) => {
        started = r;
      });
      const mutation = app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`set local statement_timeout='5s'`;
        const [backend] = await tx`select pg_backend_pid() as pid`;
        pid = backend!.pid;
        started();
        if (operation === "flag")
          await tx`insert into compliance_flags(workspace_id,listing_version_id,code,severity,status,details) values (${ws},${versionId},'test','blocking','open','{}')`;
        if (operation === "confirmation")
          await tx`insert into review_confirmations(workspace_id,listing_id,version_id,field_confirmations,negative_confirmations) values (${ws},${listingId},${versionId},'{}','{}') on conflict(workspace_id,version_id) do update set revision=review_confirmations.revision+1`;
        if (operation === "source")
          await tx`update platform_products set content_digest=${"d".repeat(64)} where workspace_id=${ws} and remote_product_id='lock-product'`;
      });
      // Attach a rejection handler immediately, then inspect real backend lock state.
      const finished = mutation.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      await ready;
      let blocked = false;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const [state] =
            await admin`select wait_event_type from pg_stat_activity where pid=${pid}`;
          if (state?.wait_event_type === "Lock") {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
        await holder;
      }
      expect(await finished).toEqual({ ok: true });
    });
  }
});
