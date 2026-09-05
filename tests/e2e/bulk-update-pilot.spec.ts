import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { BULK_FORM_COLUMNS } from "../../packages/shopline/src/bulk-form.js";
import { writeBulkFormWorkbook } from "../../packages/shopline/src/bulk-form-xlsx.js";
import {
  ADMIN_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";

// Task 4 covers import only. Enrichment/export/reconciliation are subsequent slices.
test.describe.configure({ mode: "serial" });
let fixture: Awaited<ReturnType<typeof prepareBulkImportFixture>>;
const filename = "合成目錄 &+?#.xlsx";
const defaults: Record<string, string> = {
  productId: "synthetic-import-0001",
  nameEn: "Synthetic Riesling",
  nameZh: "Synthetic Riesling",
  sku: "0001",
  regularPrice: "100",
  quantity: "6",
  updateQuantity: "+0",
};
const workbook = Buffer.from(
  writeBulkFormWorkbook([
    BULK_FORM_COLUMNS.map((c) => c.en),
    BULK_FORM_COLUMNS.map((c) => c.zh),
    BULK_FORM_COLUMNS.map((c) => defaults[c.key] ?? ""),
  ]),
);
test.beforeAll(async () => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1",
    "Set PLAYWRIGHT_E2E=1 with isolated local test services.",
  );
  fixture = await prepareBulkImportFixture();
});

test("operator supplies explicit Hong Kong export time and retries a synthetic workbook through the real import API", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signInBulkImportOperator(page, fixture);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/listings/import"
    )
      requests.push(request.url());
  });
  const file = page.locator("#bulk-import-file");
  const time = page.locator("#merchant-attested-export-at");
  const submit = page.getByRole("button", { name: "開始匯入 Import" });
  await file.setInputFiles({
    name: filename,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  });
  await expect(time).toHaveValue("");
  await expect(page.getByText(/UTC\+08:00/)).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("status")).toContainText(
    "Enter the SHOPLINE export time.",
  );
  expect(requests).toHaveLength(0);
  await time.fill("2026-01-01T00:15");
  const missingConnection = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/listings/import",
  );
  await submit.click();
  expect((await missingConnection).status()).toBe(409);
  await expect(page.getByRole("status")).toContainText(
    "Connect a SHOPLINE store",
  );
  await expect(time).toHaveValue("2026-01-01T00:15");
  expect(
    await file.evaluate(
      (element: HTMLInputElement) => element.files?.[0]?.name,
    ),
  ).toBe(filename);

  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`INSERT INTO shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) VALUES (${fixture.connectionId},${fixture.workspaceId},'synthetic-import.invalid','synthetic-disabled')`;
    await page.route(
      "**/api/listings/import?**",
      (route) => route.abort("failed"),
      { times: 1 },
    );
    await submit.click();
    await expect(page.getByRole("status")).toContainText(
      "Could not reach the server",
    );
    await expect(time).toHaveValue("2026-01-01T00:15");
    const success = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/listings/import",
    );
    await submit.click();
    const response = await success;
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({
      parsedRows: 1,
      createdDrafts: 1,
      refreshedProducts: 0,
    });
    await expect(page.getByText(/已解析 1 列/)).toBeVisible();
    const sent = new URL(response.request().url());
    expect(sent.searchParams.get("filename")).toBe(filename);
    expect(sent.searchParams.get("merchantAttestedExportAt")).toBe(
      "2025-12-31T16:15:00.000Z",
    );
    // Chromium does not expose File upload bytes via postDataBuffer; verify
    // the real handler persisted the exact received workbook digest below.
    const [record] =
      await admin`SELECT filename,sheet_name,merchant_attested_export_at,workbook_sha256 FROM source_imports WHERE workspace_id=${fixture.workspaceId}`;
    expect(record).toMatchObject({
      filename,
      sheet_name: "Default",
      workbook_sha256: createHash("sha256").update(workbook).digest("hex"),
    });
    expect(record!.merchant_attested_export_at.toISOString()).toBe(
      "2025-12-31T16:15:00.000Z",
    );
    const rows =
      await admin`SELECT raw_row FROM source_row_snapshots WHERE workspace_id=${fixture.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw_row.sku).toBe("0001");
    expect(pageErrors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("import-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(submit).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("import-mobile.png"),
      fullPage: true,
    });
  } finally {
    await admin.end();
  }
});

test("viewer import is rejected by the real handler", async ({ page }) => {
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`UPDATE memberships SET role='viewer' WHERE workspace_id=${fixture.workspaceId} AND user_id=${fixture.userId}`;
  } finally {
    await admin.end();
  }
  await signInBulkImportOperator(page, fixture);
  await page.locator("#bulk-import-file").setInputFiles({
    name: filename,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  });
  await page.locator("#merchant-attested-export-at").fill("2026-01-01T00:15");
  const forbidden = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/listings/import",
  );
  await page.getByRole("button", { name: "開始匯入 Import" }).click();
  expect((await forbidden).status()).toBe(403);
  await expect(page.getByRole("status")).toContainText(
    "Operator access is required",
  );
});
