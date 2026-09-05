import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { BULK_FORM_COLUMNS } from "../../packages/shopline/src/bulk-form.js";
import {
  readBulkFormSheet,
  writeBulkFormWorkbook,
} from "../../packages/shopline/src/bulk-form-xlsx.js";
import {
  ADMIN_URL,
  prepareBulkImportFixture,
  prepareBulkUpdateFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";

// Import authorization and the attended Task 5 delivery journey use synthetic data.
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

test("reviewer completes attended Bulk Update and reconciles mixed operator reports", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(10_000);
  const operator = await prepareBulkUpdateFixture();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await signInBulkImportOperator(page, operator);
  const rows = ["0001", "0002"].map((sku) => ({
    ...defaults,
    productId: "synthetic-update-" + sku,
    sku,
    nameEn: "Demo Estate Riesling wine 2024, Germany, Mosel, 750ml, 12.5% ABV",
    nameZh: "",
  }));
  const input = Buffer.from(
    writeBulkFormWorkbook([
      BULK_FORM_COLUMNS.map((c) => c.en),
      BULK_FORM_COLUMNS.map((c) => c.zh),
      ...rows.map((row) =>
        BULK_FORM_COLUMNS.map((c) => row[c.key as keyof typeof row] ?? ""),
      ),
    ]),
  );
  await page.locator("#bulk-import-file").setInputFiles({
    name: "synthetic-task5.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: input,
  });
  const attested = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
  await page.locator("#merchant-attested-export-at").fill(attested);
  const imported = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/listings/import" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "開始匯入 Import" }).click();
  expect((await imported).status()).toBe(201);
  await page.goto("/batches");
  await page.getByLabel(/Label/).fill("Synthetic attended update");
  await page.getByLabel(/Budget/).fill("1");
  await page.getByLabel(/Wave size/).fill("2");
  const created = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/enrichment-batches" &&
      r.request().method() === "POST",
    { timeout: 10_000 },
  );
  await page.getByRole("button", { name: /Create batch/ }).click();
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  const { batchId, selected } = await createdResponse.json();
  expect(selected).toBe(2);
  await page.goto("/batches/" + batchId);
  const advanced = page.waitForResponse(
    (r) =>
      r.url().endsWith("/" + batchId + "/advance") &&
      r.request().method() === "POST",
    { timeout: 10_000 },
  );
  await page.getByRole("button", { name: /Advance/ }).click();
  expect((await advanced).status()).toBe(200);
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  let listingIds: string[];
  try {
    await expect
      .poll(
        async () => {
          const drafts =
            await admin`SELECT id,status FROM listing_drafts WHERE workspace_id=${operator.workspaceId} ORDER BY created_at,id`;
          return drafts.filter((d) => d.status === "in_review").length;
        },
        {
          timeout: 60_000,
          message: "Fake AI Queue must enrich both imported drafts",
        },
      )
      .toBe(2);
    const drafts =
      await admin`SELECT id FROM listing_drafts WHERE workspace_id=${operator.workspaceId} ORDER BY created_at,id`;
    listingIds = drafts.map((d) => d.id);
  } finally {
    await admin.end();
  }

  // The attended follow-up reconciles the completed wave without enqueueing more work.
  const reconciledBatch = page.waitForResponse(
    (r) =>
      r.url().endsWith("/" + batchId + "/advance") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Advance/ }).click();
  const batchResponse = await reconciledBatch;
  expect(batchResponse.status()).toBe(200);
  expect(await batchResponse.json()).toMatchObject({
    status: "completed",
    enqueued: 0,
  });
  await expect(page.getByText("succeeded: 2", { exact: true })).toBeVisible();
  for (const [index, id] of listingIds.entries()) {
    await page.goto("/listings/" + id);
    await page
      .getByRole("textbox", { name: /商品名稱（繁中）/ })
      .fill("合成審核商品 " + (index + 1));
    await page.getByRole("button", { name: /儲存草稿/ }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
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
      const box = page.locator("#confirmation-field-" + key);
      await box.click();
      await expect(box).toBeChecked();
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
      const box = page.locator("#confirmation-negative-" + key);
      await box.click();
      await expect(box).toBeChecked();
    }
    await page.getByRole("button", { name: /批准上架/ }).click();
    await expect(page.getByText(/Listing approved/)).toBeVisible();
  }
  await page.goto("/catalog");
  await page.getByLabel("Select 0001 for Bulk Update", { exact: true }).check();
  await page.getByLabel("Select 0002 for Bulk Update", { exact: true }).check();
  const generate = page.getByRole("button", {
    name: "Generate Bulk Update XLSX",
    exact: true,
  });
  await expect(generate).toBeDisabled();
  await page
    .getByLabel("I confirm this SHOPLINE source export is still current.", {
      exact: true,
    })
    .check();

  await expect(generate).toBeEnabled();
  const exportedResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/listings/export" &&
      r.request().method() === "POST",
  );
  await generate.click();
  const exported = await exportedResponse;
  expect(exported.status()).toBe(200);
  const receipt = await exported.json();
  expect(receipt.rowCount).toBe(2);
  expect(receipt.artifactStatus).toBe("ready");
  expect(receipt.manifest.map((m: { outcome: string }) => m.outcome)).toEqual([
    "included",
    "included",
  ]);
  const attemptId: string = receipt.exportAttemptId;
  const attempt = page.locator('[data-export-attempt-id="' + attemptId + '"]');
  await expect(attempt).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await attempt.getByRole("link", { name: /Download/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const bytes = await readFile((await download.path())!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    receipt.artifactSha256,
  );
  const sheet = readBulkFormSheet(bytes);
  expect(sheet).toHaveLength(4);
  const skuIndex = BULK_FORM_COLUMNS.findIndex((c) => c.key === "sku");
  const neutralIndex = BULK_FORM_COLUMNS.findIndex(
    (c) => c.key === "updateQuantity",
  );
  const nameIndex = BULK_FORM_COLUMNS.findIndex((c) => c.key === "nameZh");
  expect(
    sheet
      .slice(2)
      .map((row) => row[skuIndex])
      .sort(),
  ).toEqual(["0001", "0002"]);
  for (const row of sheet.slice(2)) {
    expect(row[neutralIndex]).toBe("+0");
    expect(row[nameIndex]).toMatch(/^合成審核商品 /);
  }
  await page.goto("/jobs");
  const ledgerAttempt = page.locator(
    '[data-export-attempt-id="' + attemptId + '"]',
  );
  await expect(ledgerAttempt).toBeVisible();
  const first = ledgerAttempt.locator(
    '[data-listing-id="' + listingIds[0] + '"]',
  );
  await first
    .getByRole("combobox", { name: "Outcome", exact: true })
    .selectOption("accepted");
  const recorded = page.waitForResponse(
    (r) =>
      r.url().endsWith("/" + listingIds[0] + "/shopline-import-result") &&
      r.request().method() === "POST",
  );
  await first
    .getByRole("button", { name: "Record operator result", exact: true })
    .click();
  expect((await recorded).status()).toBe(201);
  await expect(first).toContainText("Operator reported accepted");
  const second = ledgerAttempt.locator(
    '[data-listing-id="' + listingIds[1] + '"]',
  );
  await second
    .getByRole("combobox", { name: "Outcome", exact: true })
    .selectOption("rejected");
  await second
    .getByLabel("Rejection reason", { exact: true })
    .fill("Synthetic SHOPLINE import rejected the row");
  const rejected = page.waitForResponse(
    (r) =>
      r.url().endsWith("/" + listingIds[1] + "/shopline-import-result") &&
      r.request().method() === "POST",
  );
  await second
    .getByRole("button", { name: "Record operator result", exact: true })
    .click();
  expect((await rejected).status()).toBe(201);
  await page.reload();
  await expect(ledgerAttempt).toContainText("Operator reported accepted");
  await expect(ledgerAttempt).toContainText(
    "Synthetic SHOPLINE import rejected the row",
  );
  const jobs = await (await page.request.get("/api/jobs")).json();
  const reconciled = jobs.exportReconciliations.find(
    (entry: { attempt: { id: string } }) => entry.attempt.id === attemptId,
  );
  expect(reconciled.reconciliation.counts).toEqual({
    requested: 2,
    included: 2,
    excluded: 0,
    noOp: 0,
    accepted: 1,
    rejected: 1,
    unreported: 0,
  });
  expect(reconciled.reconciliation.verificationStatus).toBe("unverified");
  expect(
    reconciled.reconciliation.members.every(
      (member: { history: unknown[] }) => member.history.length === 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("task5-jobs-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("task5-jobs-mobile.png"),
    fullPage: true,
  });

  // The first correction reaches the real server but its response is lost.
  // Retry must reuse the logical key and preserve exactly two history rows.
  const secondMember = reconciled.reconciliation.members.find(
    (member: { listingId: string }) => member.listingId === listingIds[1],
  );
  const predecessor = secondMember.latestResult.id;
  let committedCorrection: { id: string } | undefined;
  let firstCorrectionKey: string | undefined;
  await page.route(
    "**/api/listings/" + listingIds[1] + "/shopline-import-result",
    async (route) => {
      firstCorrectionKey = route.request().postDataJSON().idempotencyKey;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedCorrection = (await response.json()).result;
      await route.abort("failed");
    },
    { times: 1 },
  );
  await second
    .getByRole("combobox", { name: "Outcome", exact: true })
    .selectOption("accepted");
  await second
    .getByLabel("Correction reason", { exact: true })
    .fill("Synthetic operator corrected the rejected report");
  await second
    .getByRole("button", { name: "Record correction", exact: true })
    .click();
  await expect(second.getByRole("alert")).toBeVisible();
  const retry = page.waitForResponse(
    (r) =>
      r.url().endsWith("/" + listingIds[1] + "/shopline-import-result") &&
      r.request().method() === "POST",
  );
  await second
    .getByRole("button", { name: "Record correction", exact: true })
    .click();
  const retryResponse = await retry;
  expect(retryResponse.status()).toBe(200);
  expect(retryResponse.request().postDataJSON().idempotencyKey).toBe(
    firstCorrectionKey,
  );
  expect(await retryResponse.json()).toMatchObject({
    replayed: true,
    result: { id: committedCorrection!.id, supersedesResultId: predecessor },
  });
  await page.reload();
  await expect(second).toContainText(
    "Synthetic operator corrected the rejected report",
  );
  await expect(second).toContainText(
    "Synthetic SHOPLINE import rejected the row",
  );
  const detail = await (
    await page.request.get("/api/listings/export/" + attemptId)
  ).json();
  expect(detail.reconciliation.counts).toMatchObject({
    accepted: 2,
    rejected: 0,
    unreported: 0,
  });
  expect(detail.reconciliation.verificationStatus).toBe("unverified");
  expect(
    detail.reconciliation.members.find(
      (member: { listingId: string }) => member.listingId === listingIds[1],
    ).history,
  ).toHaveLength(2);

  const evidenceDb = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const [audit] =
      await evidenceDb`SELECT count(*)::int AS count FROM audit_events WHERE workspace_id=${operator.workspaceId} AND action='listing.shopline_import_result_recorded'`;
    expect(audit!.count).toBe(3);
    const [publishes] =
      await evidenceDb`SELECT count(*)::int AS count FROM publish_jobs WHERE workspace_id=${operator.workspaceId}`;
    expect(publishes!.count).toBe(0);
    const aiRuns =
      await evidenceDb`SELECT model,estimated_cost_usd FROM ai_runs WHERE workspace_id=${operator.workspaceId}`;
    expect(aiRuns).toHaveLength(4);
    expect(
      aiRuns.every(
        (run) =>
          run.model === "fake-listing-provider" &&
          Number(run.estimated_cost_usd) === 0,
      ),
    ).toBe(true);
  } finally {
    await evidenceDb.end();
  }
  expect(pageErrors).toEqual([]);
});
