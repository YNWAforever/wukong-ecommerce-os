import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase } from "@wukong/db";
import { emptyWorkingListing } from "@wukong/core";
import { BULK_FORM_COLUMNS } from "@wukong/shopline";
import { createBulkFormImporter } from "../../../lib/bulk-form-import";
import { createEnrichmentBatchService } from "../../../lib/enrichment-batch-service";
const db = createDatabase(process.env.TEST_DATABASE_URL!, {
  migrationUrl: process.env.TEST_DATABASE_ADMIN_URL!,
});
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  max: 1,
  prepare: false,
});
const previousProvider = process.env.AI_PROVIDER;
beforeAll(async () => {
  process.env.AI_PROVIDER = "fake";
  await db.migrate();
});
afterAll(async () => {
  if (previousProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = previousProvider;
  await db.close();
  await admin.end();
});
it.each([false, true])(
  "admits imported drafts without dropping commercial inputs or replacing saved corrections (%s)",
  async (corrected) => {
    const ws = `import-admission-${randomUUID()}`;
    await admin`insert into workspaces(id,name,profile) values (${ws},'Synthetic','{}')`;
    await admin`insert into users(id,email) values (${ws},${ws + "@example.invalid"})`;
    await db.forWorkspace(ws, async (r) => {
      await r.workspaces.updateProfile({
        name: "Synthetic",
        currency: "HKD",
        locales: ["en", "zh-Hant"],
        tone: "Clear",
        claimPolicy: [],
        requiredFields: [],
        brandBackgroundColor: null,
      });
      await r.shoplineConnections.create({
        shopDomain: "synthetic.invalid",
        accessToken: "synthetic-disabled",
        base64Key: Buffer.alloc(32).toString("base64"),
      });
    });
    const row: Record<string, string> = {
      productId: "remote-synthetic",
      nameEn: "Demo Estate Riesling wine 2024 Germany 750ml 12.5% ABV",
      nameZh: "",
      sku: "001",
      regularPrice: "100",
      quantity: "6",
      updateQuantity: "+0",
    };
    const sheet = [
      BULK_FORM_COLUMNS.map((c) => c.en),
      BULK_FORM_COLUMNS.map((c) => c.zh),
      BULK_FORM_COLUMNS.map((c) => row[c.key] ?? ""),
    ];
    await createBulkFormImporter({ getDatabase: () => db })({
      workspaceId: ws,
      actorId: ws,
      sheet,
      rawBytes: new Uint8Array([1, 2, 3]),
      merchantAttestedExportAt: new Date(),
      filename: "synthetic.xlsx",
      sheetName: "Default",
    });
    const listingId = await db.forWorkspace(
      ws,
      async (r) => (await r.platformProducts.listRecent(1))[0]!.listingId!,
    );
    if (corrected)
      await db.forWorkspace(ws, (r) =>
        r.listingInputs.initialize(
          {
            listingId,
            actorId: ws,
            note: "Saved correction",
            workingContent: {
              ...emptyWorkingListing(),
              sku: "CORRECTED",
              priceHkd: 123,
              stockQuantity: 9,
            },
          },
          { workspaceId: ws, actorId: ws, entityId: listingId },
          r.audit,
        ),
      );
    else
      expect(
        await db.forWorkspace(ws, (r) => r.listingInputs.getCurrent(listingId)),
      ).toBeNull();
    const enqueue = vi.fn(async () => ({ id: randomUUID() }));
    const service = createEnrichmentBatchService({
      getDatabase: () => db,
      publisher: { enqueue },
    });
    const created = await service.createBatch({
      workspaceId: ws,
      actorId: ws,
      label: "Imported recovery",
      gap: "untranslatedName",
      budgetUsd: 1,
      waveSize: 1,
    });
    const detail = await service.getBatch({
      workspaceId: ws,
      batchId: created.batchId,
    });
    const command = {
      workspaceId: ws,
      actorId: ws,
      batchId: created.batchId,
      expectedControlRevision: detail.batch.controlRevision,
      idempotencyKey: randomUUID(),
    };
    const accepted = await service.advanceBatch(command);
    expect(accepted.acceptedRunIds).toHaveLength(1);
    const snapshot = await db.forWorkspace(ws, (r) =>
      r.listingInputs.getCurrent(listingId),
    );
    expect(snapshot?.revision).toBe(1);
    expect(snapshot?.workingContent).toMatchObject(
      corrected
        ? { sku: "CORRECTED", priceHkd: 123, stockQuantity: 9 }
        : { sku: "001", priceHkd: 100, stockQuantity: 6 },
    );
    expect(snapshot?.fieldStates.sku).toMatchObject({
      owner: "operator",
      state: "manual",
    });
    if (corrected) expect(snapshot?.note).toBe("Saved correction");
    else
      expect(snapshot?.note).toContain(
        "Imported from a SHOPLINE bulk update form",
      );
    const replay = await service.advanceBatch(command);
    expect(replay.acceptedRunIds).toEqual(accepted.acceptedRunIds);
    expect(enqueue).toHaveBeenCalledTimes(1);
  },
);
