import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  completeMockShoplinePublish,
  enrollAndSignInOpakAdmin,
  prepareRealStackFixture,
  verifyCompletedAudit,
  verifyUploadedAsset,
} from "./real-stack-fixture.js";

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

  await expect(page.getByRole("heading", { name: "來源依據" })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByRole("heading", { name: "商品欄位" })).toBeVisible();
  await expect(
    page.locator("blockquote").filter({ hasText: "SKU OPAK-DEMO-001" }),
  ).toBeVisible();
  await expect(page.getByText(/沒有需要處理的合規提示/)).toBeVisible();

  const title = page.getByLabel("商品名稱（英文）");
  await title.fill("Opak Cellar Riesling 2024 — reviewed");
  await page.getByRole("button", { name: /儲存草稿/ }).click();
  await expect(page.getByText(/Draft saved/)).toBeVisible();
  await expect(title).toHaveValue("Opak Cellar Riesling 2024 — reviewed");

  await page.getByRole("button", { name: /批准上架/ }).click();
  await expect(page.getByText(/Listing approved/)).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /匯出 SHOPLINE CSV/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-opak-\d{4}-\d{2}\.csv$/);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const csv = await readFile(downloadPath!, "utf8");
  expect(csv).toContain("OPAK-DEMO-001,Opak Cellar Riesling 2024 — reviewed");

  const queuedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/listings/${draftId}/deliver`) &&
      response.request().method() === "POST" &&
      response.status() === 202,
  );
  await page.getByRole("button", { name: /發布至 SHOPLINE/ }).click();
  expect((await queuedResponse).status()).toBe(202);
  await expect(page.getByText(/Publish queued/)).toBeVisible();

  const published = await completeMockShoplinePublish(draftId!);
  expect(published).toMatchObject({
    status: "published",
    remoteProductId: "remote_opak_e2e_123",
  });
  await page.reload();
  await expect(page.locator(".review-status")).toContainText("published");
  await expect(page.getByText("remote_opak_e2e_123")).toBeVisible();

  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/real-stack-draft-id.txt", draftId!, "utf8");

  const audit = await verifyCompletedAudit(draftId!);
  expect(audit.missingActions).toEqual([]);
  expect(audit.aiRunTasks).toEqual(["extract", "generate"]);
  expect(audit.accessibleForeignRecordCount).toBe(0);
  expect(audit.accessibleForeignTables).toEqual([]);
  expect(audit.passed).toBe(true);
});
