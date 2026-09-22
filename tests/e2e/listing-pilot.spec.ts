import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  OPAK_WORKSPACE_ID,
  enrollAndSignInOpakAdmin,
  expectedMockShoplineRemoteId,
  prepareRealStackFixture,
  verifyCompletedAudit,
  verifyUploadedAsset,
} from "./real-stack-fixture.js";

async function onePagePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([72, 72]);
  return Buffer.from(await document.save());
}
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index]!;
    if (char === '"') {
      if (quoted && row[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1",
    "Set PLAYWRIGHT_E2E=1 to run the real local-stack pilot.",
  );
  await prepareRealStackFixture();
});

test("Opak admin completes real intake, AI review, approval, CSV, and mock SHOPLINE delivery", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await enrollAndSignInOpakAdmin(page);

  const bottleLabel = {
    name: "bottle-label.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  };
  const fileInput = page.locator("#listing-files");
  await fileInput.setInputFiles(bottleLabel);
  await expect(page.locator(".file-row strong")).toHaveText([
    "bottle-label.png",
  ]);

  await fileInput.setInputFiles({
    name: "back-label.png",
    mimeType: "image/png",
    buffer: bottleLabel.buffer,
  });
  await expect(page.locator(".file-row strong")).toHaveText([
    "bottle-label.png",
    "back-label.png",
  ]);

  await page
    .locator(".file-row", { hasText: "bottle-label.png" })
    .getByRole("button", { name: /移除/ })
    .click();
  await fileInput.setInputFiles(bottleLabel);
  await fileInput.setInputFiles([]);
  await expect(page.locator(".file-row strong")).toHaveText([
    "back-label.png",
    "bottle-label.png",
  ]);
  await expect(page.locator(".file-preview")).toHaveCount(2);
  await page.screenshot({
    path: "test-results/t03-native-selection.png",
    fullPage: true,
  });

  await page
    .getByLabel("Operator notes")
    .fill(
      "Opak Cellar Riesling wine 2024, Germany, Mosel, Riesling, 750ml, 12.5% ABV, SKU OPAK-DEMO-001, HK$288, stock 12",
    );
  await page.getByRole("button", { name: /建立上架草稿/ }).click();
  await expect(page).toHaveURL(
    /\/listings\/[0-9a-f-]{36}\?processing=queued$/i,
  );
  const draftId = page.url().match(/\/listings\/([0-9a-f-]{36})/i)?.[1];
  expect(draftId).toBeTruthy();
  await verifyUploadedAsset(draftId!);

  for (const method of ["csv", "shopline_api"] as const) {
    const blocked = await page.request.post(
      `/api/listings/${draftId}/deliver`,
      { data: { method } },
    );
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "approval_required" });
  }

  await expect(
    page.getByRole("heading", { name: "Source evidence" }),
  ).toBeVisible({
    timeout: 45_000,
  });
  await expect(
    page.getByRole("heading", { name: "Listing fields" }),
  ).toBeVisible();
  await expect(
    page.locator("blockquote").filter({ hasText: "Opak Cellar" }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("No open compliance flags", { exact: true }),
  ).toBeVisible();

  // Commercial facts remain operator-owned. Save them through the working
  // document, then process that immutable revision before reviewing its version.
  await page
    .getByText("Edit sources, notes and working draft", { exact: true })
    .click();
  await page.getByLabel("Merchant SKU").fill("OPAK-DEMO-001");
  await page.getByLabel("Selling price (HK$)").fill("288");
  await page.getByLabel("Stock", { exact: true }).fill("12");
  await page.getByRole("button", { name: "Save and process with AI" }).click();
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/listings/${draftId}`);
        if (!response.ok()) return null;
        const body = (await response.json()) as {
          activeVersion?: {
            content?: {
              sku?: string | null;
              priceHkd?: number | null;
              stockQuantity?: number | null;
            };
          } | null;
        };
        return body.activeVersion?.content ?? null;
      },
      { timeout: 45_000 },
    )
    .toMatchObject({
      sku: "OPAK-DEMO-001",
      priceHkd: 288,
      stockQuantity: 12,
    });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Listing fields" }),
  ).toBeVisible();

  const title = page.getByLabel("Title (English)", { exact: true });
  await title.fill("Opak Cellar Riesling 2024 — reviewed");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText(/Draft saved/)).toBeVisible();
  await expect(title).toHaveValue("Opak Cellar Riesling 2024 — reviewed");

  // The approve button stays disabled until all 8 AI-written-field and 7
  // negative-condition confirmations are checked (apps/web/lib/review-
  // confirmation-keys.ts's CONFIRMATION_FIELD_KEYS/CONFIRMATION_NEGATIVE_KEYS,
  // rendered by ConfirmationChecklist with matching #confirmation-field-<key>
  // / #confirmation-negative-<key> checkbox ids) -- kept as a literal list
  // here rather than importing across the app/e2e boundary. Each checkbox is
  // a server-round-trip-controlled input (its onChange PATCHes
  // /review-confirmations and only reflects `checked` once that resolves and
  // the snapshot reloads), so `.check()`'s single immediate post-click
  // verification always fails here -- click, then wait for the settled state
  // with an assertion that actually retries.
  for (const key of [
    "nameZh",
    "summaryEn",
    "summaryZh",
    "seoTitleEn",
    "seoTitleZh",
    "seoDescriptionEn",
    "seoDescriptionZh",
    "seoKeywords",
  ]) {
    const checkbox = page.locator(`#confirmation-field-${key}`);
    await checkbox.click();
    await expect(checkbox).toBeChecked();
  }
  for (const key of [
    "priceUnchanged",
    "membershipUnchanged",
    "categoryUnchanged",
    "statusUnchanged",
    "supplierUnchanged",
    "quantityDeltaNeutral",
    "noImageChange",
  ]) {
    const checkbox = page.locator(`#confirmation-negative-${key}`);
    await checkbox.click();
    await expect(checkbox).toBeChecked();
  }

  await page
    .getByRole("button", { name: "Approve listing", exact: true })
    .click();
  await expect(page.getByText(/Listing approved/)).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Create CSV · CSV fallback", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-opak-\d{4}-\d{2}\.csv$/);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const csv = await readFile(downloadPath!, "utf8");
  expect(csv).toContain("OPAK-DEMO-001,Opak Cellar Riesling 2024 — reviewed");

  const csvRows = csv.trimEnd().split("\r\n");
  const csvImageUrls = parseCsvRow(csvRows[1]!)[13]?.split(";") ?? [];
  expect(csvImageUrls).toHaveLength(2);
  // Verify every presigned image URL emitted in the multi-image CSV field.
  for (const csvImageUrl of csvImageUrls) {
    expect(csvImageUrl).toMatch(/^https?:\/\//);
    const imageResponse = await page.request.get(csvImageUrl);
    expect(imageResponse.ok()).toBe(true);
    expect(imageResponse.headers()["content-type"]).toMatch(/^image\//);
    const imageBytes = await imageResponse.body();
    expect(imageBytes.byteLength).toBeGreaterThan(0);
    expect(Number(imageResponse.headers()["content-length"])).toBe(
      imageBytes.byteLength,
    );
  }

  const queuedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/listings/${draftId}/deliver`) &&
      response.request().method() === "POST" &&
      response.status() === 202,
  );
  await page
    .getByRole("button", { name: "Create via API", exact: true })
    .click();
  expect((await queuedResponse).status()).toBe(202);
  await expect(page.getByText(/Publish queued/)).toBeVisible();

  let expectedRemoteProductId = "";
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/listings/${draftId}`);
        if (!response.ok()) return false;
        const listing = (await response.json()) as {
          activeVersion?: { id?: string };
          delivery?: { status?: string; remoteProductId?: string | null };
        };
        const versionId = listing.activeVersion?.id;
        if (!versionId) return false;
        expectedRemoteProductId = expectedMockShoplineRemoteId(versionId);
        return (
          listing.delivery?.status === "published" &&
          listing.delivery.remoteProductId === expectedRemoteProductId
        );
      },
      {
        message: "SHOPLINE Queue consumer did not publish the listing",
        timeout: 60_000,
      },
    )
    .toBe(true);
  expect(expectedRemoteProductId).toMatch(/^mock_[a-f0-9]{16}$/);

  await page.reload();
  await expect(page.locator(".review-status")).toContainText("Published");
  await expect(page.getByText(expectedRemoteProductId)).toBeVisible();
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/real-stack-draft-id.txt", draftId!, "utf8");
  await page.screenshot({
    path: "test-results/listing-pilot-complete.png",
    fullPage: true,
  });
  await writeFile(
    "test-results/real-stack-workspace-id.txt",
    OPAK_WORKSPACE_ID,
    "utf8",
  );

  const audit = await verifyCompletedAudit(draftId!);
  expect(audit.missingActions).toEqual([]);
  expect(audit.aiRunTasks).toEqual([
    "extract",
    "generate",
    "extract",
    "generate",
  ]);
  expect(audit.accessibleForeignRecordCount).toBe(0);
  expect(audit.accessibleForeignTables).toEqual([]);
  expect(audit.passed).toBe(true);
});
