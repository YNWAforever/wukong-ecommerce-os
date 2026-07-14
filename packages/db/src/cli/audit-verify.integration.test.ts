import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { verifyAudit } from "./audit-verify.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.DATABASE_ADMIN_URL ?? "postgres://wukong:wukong@localhost:54329/wukong";
const runtimeUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!adminUrl || !runtimeUrl)("audit foreign-table probe", () => {
  it("does not expose foreign tenant rows through the runtime role", async () => {
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    const workspaceId = `audit_probe_${randomUUID().slice(0, 8)}`;
    let draftId = "";
    try {
      await admin.begin(async (transaction) => {
        await transaction`insert into workspaces (id, name, profile) values (${workspaceId}, 'Audit probe', '{}'::jsonb)`;
        const [draft] = await transaction`insert into listing_drafts (workspace_id, target) values (${workspaceId}, 'shopline') returning id`;
        draftId = String(draft?.id);
        await transaction`insert into source_assets (workspace_id, listing_id, storage_key, kind, metadata) values (${workspaceId}, ${draftId}, 'audit-probe/fixture.svg', 'image', '{}'::jsonb)`;
      });

      const result = await verifyAudit({ workspaceId: "ws_opak", draftId, url: runtimeUrl! });
      expect(result.accessibleForeignRecordCount).toBe(0);
      expect(result.accessibleForeignTables).toEqual([]);
      expect(result.passed).toBe(false);
    } finally {
      await admin`delete from workspaces where id = ${workspaceId}`;
      await admin.end();
    }
  });
});