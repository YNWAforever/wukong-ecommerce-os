import { expect, test } from "@playwright/test";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_E2E !== "1", "Set PLAYWRIGHT_E2E=1 to run the deterministic pilot server.");
});

test("Opak operator completes intake, evidence review, approval, CSV, and mock delivery", async ({ page }) => {
  await page.goto("/listings/new");
  await page.getByLabel("產品圖片或文件").setInputFiles({
    name: "bottle-label.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Opak Cellar</text></svg>"),
  });
  await page.getByLabel("補充資料").fill("Opak Cellar Riesling 2024, Germany, Mosel, Riesling, 750ml, 12.5% ABV, SKU OPAK-DEMO-001, HK$288");
  await page.getByRole("button", { name: "建立上架草稿" }).click();
  await expect(page.getByText("待補資料")).toBeVisible();
  await expect(page.getByText("來源證據")).toBeVisible();
  await expect(page.getByText("庫存：需要資料")).toBeVisible();

  const beforeApproval = await page.request.post("/api/listings/draft-1/deliver", { data: { method: "csv" } });
  expect(beforeApproval.status()).toBe(409);

  await page.getByRole("button", { name: "進入審核" }).click();
  await page.getByLabel("英文標題").fill("Opak Cellar Riesling 2024 — reviewed");
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.getByText("已更新審核版本")).toBeVisible();
  await page.getByRole("button", { name: "批准上架" }).click();
  await expect(page.getByText("已批准")).toBeVisible();

  await page.getByRole("button", { name: "下載 SHOPLINE CSV" }).click();
  await expect(page.getByText("CSV 已建立")).toBeVisible();
  await page.getByRole("button", { name: "發佈至 SHOPLINE 測試連接" }).click();
  await expect(page.getByText("queued/mock remote_123")).toBeVisible();
});
