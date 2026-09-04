import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "@wukong/db";
import { MemoryAssetStore } from "@wukong/assets";
import { BULK_FORM_COLUMNS } from "@wukong/shopline";
import {
  readBulkFormSheet,
  writeBulkFormWorkbook,
} from "@wukong/shopline/bulk-form-xlsx";
import { createBulkFormImporter } from "../../../../lib/bulk-form-import";
import { approveOne } from "../../../../lib/listing-approval";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "../../../../lib/review-confirmation-keys";
import { createExportListingsHandler } from "./route";

// This suite deliberately requires explicit isolated test-service URLs.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!;
const appUrl = process.env.TEST_DATABASE_URL!;
const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
const database = createDatabase(appUrl, { migrationUrl: adminUrl });
const workspaceId = "task3_flow_" + randomUUID().replaceAll("-", "");
const actorId = "synthetic-reviewer";
const assetStore = new MemoryAssetStore();
const importer = createBulkFormImporter({ getDatabase: () => database });
const exportHandler = createExportListingsHandler({
  getDatabase: () => database,
  getAssetStore: () => assetStore,
  sessionContext: {
    async resolve() {
      return { workspaceId, actorId, role: "reviewer" };
    },
  },
});
const content = {
  sku: "SYNTHETIC-1",
  producer: "Synthetic",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12,
  packQuantity: 1,
  priceHkd: 100,
  stockQuantity: 6,
  criticScores: [],
  awards: [],
  title: { en: "Synthetic wine", "zh-Hant": "Synthetic approved title" },
  description: {
    en: "Approved description",
    "zh-Hant": "Approved description",
  },
  seo: {
    title: { en: "Approved title", "zh-Hant": "Approved title" },
    description: {
      en: "Approved description",
      "zh-Hant": "Approved description",
    },
  },
  tags: ["synthetic"],
  imageAssetIds: [],
};
function sheet(price: string) {
  return [
    BULK_FORM_COLUMNS.map((c) => c.en),
    BULK_FORM_COLUMNS.map((c) => c.zh),
    BULK_FORM_COLUMNS.map(
      (c) =>
        (
          ({
            productId: "synthetic-remote",
            nameEn: "Synthetic wine",
            nameZh: "Original title",
            sku: "SYNTHETIC-1",
            regularPrice: price,
            quantity: "6",
            updateQuantity: "+0",
          }) as Record<string, string>
        )[c.key] ?? "",
    ),
  ];
}
async function importPrice(price: string) {
  const rows = sheet(price);
  return importer({
    workspaceId,
    actorId,
    sheet: rows,
    rawBytes: writeBulkFormWorkbook(rows),
    merchantAttestedExportAt: new Date(),
    filename: "synthetic.xlsx",
    sheetName: "Default",
  });
}
async function exportListing(listingId: string) {
  const response = await exportHandler(
    new Request("http://localhost/api/listings/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        listingIds: [listingId],
        freshnessAttested: true,
      }),
    }),
  );
  expect(response.status).toBe(200);
  return response.json();
}
beforeAll(async () => {
  if (!adminUrl || !appUrl)
    throw new Error("Explicit isolated TEST_DATABASE URLs required");
  await database.migrate();
  await admin`insert into workspaces(id,name,profile) values (${workspaceId},'Synthetic Task 3','{}')`;
  await admin`insert into shopline_connections(workspace_id,shop_domain,encrypted_access_token) values (${workspaceId},'synthetic.invalid','synthetic-disabled')`;
});
afterAll(async () => {
  await database.close();
  await admin.end();
});

it("binds the real workbook, manifest and hash to approval; re-import cannot reuse it", async () => {
  await importPrice("100");
  const [draft] =
    await admin`select id from listing_drafts where workspace_id=${workspaceId}`;
  const listingId = draft!.id as string;
  const versionId = randomUUID();
  await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${versionId},${workspaceId},${listingId},1,${admin.json(content)},${actorId})`;
  await admin`update listing_drafts set active_version_id=${versionId},status='in_review' where id=${listingId}`;
  async function confirm() {
    return database.forWorkspace(workspaceId, async (r) => {
      const link = (await r.platformProducts.getByListingId(listingId))!;
      const confirmation = await r.reviewConfirmations.upsert({
        listingId,
        versionId,
        fieldConfirmations: Object.fromEntries(
          CONFIRMATION_FIELD_KEYS.map((k) => [k, true]),
        ),
        negativeConfirmations: Object.fromEntries(
          CONFIRMATION_NEGATIVE_KEYS.map((k) => [k, true]),
        ),
        sourceImportId: link.sourceImportId,
        rowDigest: link.contentDigest,
      });
      return { link, confirmation };
    });
  }
  async function approve(review: Awaited<ReturnType<typeof confirm>>) {
    return database.forWorkspace(workspaceId, (r) =>
      approveOne(listingId, { workspaceId, actorId, entityId: listingId }, r, {
        expectedVersionId: versionId,
        confirmationLedgerRevision: review.confirmation.revision,
        sourceImportId: review.link.sourceImportId!,
        expectedRowDigest: review.link.contentDigest!,
      }),
    );
  }
  const firstReview = await confirm();
  await approve(firstReview);
  const first = await exportListing(listingId);
  expect(first).toMatchObject({ rowCount: 1, artifactStatus: "ready" });
  const attempt = (await database.forWorkspace(workspaceId, (r) =>
    r.exportAttempts.getById(first.exportAttemptId),
  ))!;
  const bytes = await assetStore.readObject(
    workspaceId,
    "ws/" +
      workspaceId +
      "/exports/" +
      first.exportAttemptId +
      "/export-" +
      first.exportAttemptId +
      ".xlsx",
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    first.artifactSha256,
  );
  expect(attempt.artifactSha256).toBe(first.artifactSha256);
  expect(attempt.manifest).toEqual(first.manifest);
  const provenance = attempt.provenance as {
    evidence: Array<{
      versionId: string;
      sourceImportId: string;
      approvalReceiptId: string;
      sourceSnapshotId: string;
    }>;
  };
  expect(provenance.evidence[0]).toMatchObject({
    versionId,
    sourceImportId: firstReview.link.sourceImportId,
  });
  expect(provenance.evidence[0]!.approvalReceiptId).toBeTruthy();
  const priceColumn = BULK_FORM_COLUMNS.findIndex(
    (c) => c.key === "regularPrice",
  );
  expect(readBulkFormSheet(bytes)[2]![priceColumn]).toBe("100");
  expect((await exportListing(listingId)).exportAttemptId).toBe(
    first.exportAttemptId,
  );

  await importPrice("105");
  const afterImport = await exportListing(listingId);
  expect(afterImport).toMatchObject({ exportAttemptId: null, rowCount: 0 });
  const secondReview = await confirm();
  expect(secondReview.link.sourceImportId).not.toBe(
    firstReview.link.sourceImportId,
  );
  expect((await exportListing(listingId)).rowCount).toBe(0);
  await approve(secondReview);
  const second = await exportListing(listingId);
  expect(second.rowCount).toBe(1);
  expect(second.exportAttemptId).not.toBe(first.exportAttemptId);
  expect(second.artifactSha256).not.toBe(first.artifactSha256);
  const secondBytes = await assetStore.readObject(
    workspaceId,
    "ws/" +
      workspaceId +
      "/exports/" +
      second.exportAttemptId +
      "/export-" +
      second.exportAttemptId +
      ".xlsx",
  );
  expect(readBulkFormSheet(secondBytes)[2]![priceColumn]).toBe("105");
  expect(
    await assetStore.readObject(
      workspaceId,
      "ws/" +
        workspaceId +
        "/exports/" +
        first.exportAttemptId +
        "/export-" +
        first.exportAttemptId +
        ".xlsx",
    ),
  ).toEqual(bytes);
  const history =
    await admin`select source_import_id,raw_row from source_row_snapshots where workspace_id=${workspaceId} order by created_at`;
  expect(history).toHaveLength(2);
  expect(history.map((row) => row.raw_row.regularPrice)).toEqual([
    "100",
    "105",
  ]);
});
