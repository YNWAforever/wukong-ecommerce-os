import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  enrollAndSignInOpakAdmin,
  expectedMockShoplineRemoteId,
  prepareRealStackFixture,
  verifyCompletedAudit,
  verifyUploadedAsset,
} from "./real-stack-fixture.js";

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

  await page.locator("#listing-files").setInputFiles([
    {
      name: "bottle-label.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    },
    {
      name: "supplier-sheet.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(
        "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
        "utf8",
      ),
    },
  ]);
  await page
    .getByLabel("補充備註")
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
    page.locator("blockquote").filter({ hasText: "SKU OPAK-DEMO-001" }),
  ).toBeVisible();
  await expect(
    page.getByText("No open compliance flags", { exact: true }),
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
  const csvImageUrl = parseCsvRow(csvRows[1]!)[13];
  expect(csvImageUrl).toMatch(/^https?:\/\//);
  // The CSV contains a presigned GET URL: verify the actual image download.
  const imageResponse = await page.request.get(csvImageUrl!);
  expect(imageResponse.ok()).toBe(true);
  expect(imageResponse.headers()["content-type"]).toMatch(/^image\//);
  const imageBytes = await imageResponse.body();
  expect(imageBytes.byteLength).toBeGreaterThan(0);
  expect(Number(imageResponse.headers()["content-length"])).toBe(
    imageBytes.byteLength,
  );

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

  const audit = await verifyCompletedAudit(draftId!);
  expect(audit.missingActions).toEqual([]);
  expect(audit.aiRunTasks).toEqual(["extract", "generate"]);
  expect(audit.accessibleForeignRecordCount).toBe(0);
  expect(audit.accessibleForeignTables).toEqual([]);
  expect(audit.passed).toBe(true);
});
