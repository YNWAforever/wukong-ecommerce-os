import { expect, test } from "@playwright/test";
import { captureDeliveryLocaleMatrix } from "./catalog-usability-checks.js";
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
  await expect(submit).toBeDisabled();
  await expect(page.getByText(/administrator|管理員/).first()).toBeVisible();
  expect(requests).toHaveLength(0);
  await time.fill("2026-01-01T00:15");
  await expect(time).toHaveValue("2026-01-01T00:15");
  expect(
    await file.evaluate(
      (element: HTMLInputElement) => element.files?.[0]?.name,
    ),
  ).toBe(filename);

  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`INSERT INTO shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) VALUES (${fixture.connectionId},${fixture.workspaceId},'synthetic-import.invalid','synthetic-disabled')`;
    await page
      .getByRole("button", { name: /Refresh status|重新整理狀態/ })
      .click();
    await expect(submit).toBeEnabled();
    await time.fill("");
    await submit.click();
    await expect(
      page.locator("form.intake-form").getByRole("status"),
    ).toContainText("Enter the SHOPLINE export time.");
    expect(requests).toHaveLength(0);
    await time.fill("2026-01-01T00:15");
    await page.route(
      "**/api/listings/import?**",
      (route) => route.abort("failed"),
      { times: 1 },
    );
    await submit.click();
    await expect(
      page.locator("form.intake-form").getByRole("status"),
    ).toContainText("Could not reach the server");
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
  await expect(
    page.getByRole("button", { name: "開始匯入 Import" }),
  ).toBeDisabled();
  const forbidden = await page.request.post(
    "/api/listings/import?filename=synthetic.xlsx&merchantAttestedExportAt=2025-12-31T16%3A15%3A00.000Z",
    {
      data: workbook,
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    },
  );
  expect(forbidden.status()).toBe(403);
  expect(await forbidden.json()).toMatchObject({ code: "insufficient_role" });
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
      .getByRole("textbox", {
        name: "Title (Traditional Chinese)",
        exact: true,
      })
      .fill("合成審核商品 " + (index + 1));
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
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
    await page
      .getByRole("button", { name: "Approve listing", exact: true })
      .click();
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

  // Compare supplied snapshots through the real browser form and immutable API.
  const comparisonPath = `/api/listings/export/${attemptId}/verifications`;
  const compare = ledgerAttempt.getByRole("region", {
    name: "Fresh export comparison",
  });
  await compare
    .getByRole("button", { name: "Compare fresh export", exact: true })
    .click();
  const compareFile = compare.getByLabel("Fresh SHOPLINE XLSX", {
    exact: true,
  });
  const compareTime = compare.getByLabel(
    "SHOPLINE export time (Hong Kong UTC+08:00)",
    { exact: true },
  );
  const snapshotTime = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19);
  const snapshotSheet = sheet.map((row) => row.map((cell) => cell ?? ""));
  const matchingBytes = Buffer.from(
    writeBulkFormWorkbook([
      ...snapshotSheet.slice(0, 2),
      ...snapshotSheet.slice(2).reverse(),
    ]),
  );
  await compareFile.setInputFiles({
    name: "matching-snapshot.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: matchingBytes,
  });
  await compareTime.fill(snapshotTime);
  await compare
    .getByLabel("I confirm this snapshot is from the same SHOPLINE store.", {
      exact: true,
    })
    .check();
  const compareSubmit = compare.getByRole("button", {
    name: "Record snapshot comparison",
    exact: true,
  });
  const compareToggle = compare.getByRole("button", {
    name: "Compare fresh export",
    exact: true,
  });
  const collapseAndReopenComparison = async (selectedName: string) => {
    await compareToggle.click();
    await expect(compareFile).toBeHidden();
    await compareToggle.click();
    await expect(compareFile).toBeVisible();
    expect(
      await compareFile.evaluate(
        (element: HTMLInputElement) => element.files?.[0]?.name,
      ),
    ).toBe(selectedName);
    await expect(compareTime).toHaveValue(snapshotTime);
    await expect(
      compare.getByLabel(
        "I confirm this snapshot is from the same SHOPLINE store.",
        { exact: true },
      ),
    ).toBeChecked();
  };
  const invalidHeader = snapshotSheet.map((row) => [...row]);
  invalidHeader[0]![0] = "Invalid header";
  const oversizedRow = snapshotSheet[2]!.map((cell, index) =>
    ["productId", "variantId"].includes(BULK_FORM_COLUMNS[index]!.key)
      ? cell
      : "x".repeat(32767),
  );
  for (const invalid of [
    {
      name: "invalid-headers.xlsx",
      buffer: Buffer.from(writeBulkFormWorkbook(invalidHeader)),
      status: 400,
      code: "comparison_workbook_invalid",
      copy: "Choose a valid current SHOPLINE workbook",
    },
    {
      name: "oversized-evidence.xlsx",
      buffer: Buffer.from(
        writeBulkFormWorkbook([...snapshotSheet.slice(0, 2), oversizedRow]),
      ),
      status: 413,
      code: "comparison_input_too_large",
      copy: "Use a smaller snapshot",
    },
  ]) {
    await compareFile.setInputFiles({
      name: invalid.name,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: invalid.buffer,
    });
    const invalidResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === comparisonPath &&
        r.request().method() === "POST",
    );
    await compareSubmit.click();
    const response = await invalidResponse;
    expect(response.status()).toBe(invalid.status);
    expect(await response.json()).toMatchObject({ code: invalid.code });
    await expect(compare.getByRole("alert")).toContainText(invalid.copy);
    expect(
      await compareFile.evaluate(
        (element: HTMLInputElement) => element.files?.[0]?.name,
      ),
    ).toBe(invalid.name);
  }
  await compareFile.setInputFiles({
    name: "matching-snapshot.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: matchingBytes,
  });
  await collapseAndReopenComparison("matching-snapshot.xlsx");
  const matchesResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === comparisonPath &&
      r.request().method() === "POST",
  );
  await compareSubmit.click();
  const matches = await matchesResponse;
  expect(matches.status()).toBe(201);
  const matchingRecord = (await matches.json()).verification;
  expect(matchingRecord.comparison).toMatchObject({
    outcome: "matches_compared_fields",
    counts: { expected: 2, matched: 2, differences: 0, missing: 0 },
  });
  expect(
    matchingRecord.comparison.products.every(
      (p: { fields: unknown[]; quantityDeltaObservations: unknown[] }) =>
        p.fields.length === 69 && p.quantityDeltaObservations.length === 2,
    ),
  ).toBe(true);
  const params = new URL(matches.request().url()).searchParams;
  expect(params.get("sameStoreAttested")).toBe("true");
  expect(params.get("merchantAttestedExportAt")).toBe(
    new Date(snapshotTime + "+08:00").toISOString(),
  );
  const changedRow = [...snapshotSheet[2]!];
  changedRow[skuIndex] = "observed-protected-sku";
  const changedBytes = Buffer.from(
    writeBulkFormWorkbook([...snapshotSheet.slice(0, 2), changedRow]),
  );
  await compareFile.setInputFiles({
    name: "changed-missing.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: changedBytes,
  });
  let committedComparison: { id: string } | undefined;
  await page.route(
    "**" + comparisonPath + "?**",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedComparison = (await response.json()).verification;
      await route.abort("failed");
    },
    { times: 1 },
  );
  await compareSubmit.click();
  await expect(compare.getByRole("alert")).toContainText("Inputs are retained");
  await expect(compareTime).toHaveValue(snapshotTime);
  expect(
    await compareFile.evaluate((e: HTMLInputElement) => e.files?.[0]?.name),
  ).toBe("changed-missing.xlsx");
  await collapseAndReopenComparison("changed-missing.xlsx");
  const comparisonRetry = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === comparisonPath &&
      r.request().method() === "POST",
  );
  await compareSubmit.click();
  const retriedComparison = await comparisonRetry;
  expect(retriedComparison.status()).toBe(200);
  const retriedBody = await retriedComparison.json();
  expect(retriedBody).toMatchObject({
    replayed: true,
    verification: { id: committedComparison!.id },
  });
  expect(retriedBody.verification.comparison).toMatchObject({
    outcome: "inconclusive",
    counts: { expected: 2, differences: 1, missing: 1 },
  });
  const differentProduct = retriedBody.verification.comparison.products.find(
    (p: { outcome: string }) => p.outcome === "differences",
  );
  expect(
    differentProduct.fields.find((f: { column: string }) => f.column === "sku"),
  ).toMatchObject({
    category: "protected",
    expected: sheet[2]![skuIndex],
    observed: "observed-protected-sku",
    different: true,
  });
  await page.reload();
  await compare
    .getByRole("button", { name: "Compare fresh export", exact: true })
    .click();
  await expect(compare).toContainText("per page; total 2");
  await compare.getByRole("button", { name: /changed-missing.xlsx/ }).click();
  await expect(
    compare.locator(`[data-verification-id="${committedComparison!.id}"]`),
  ).toBeVisible();
  const retainedHistory = await (
    await page.request.get(comparisonPath + "?page=1&pageSize=10")
  ).json();
  expect(retainedHistory.total).toBe(2);
  const afterComparison = await (
    await page.request.get("/api/listings/export/" + attemptId)
  ).json();
  expect(afterComparison.reconciliation.counts).toEqual(
    detail.reconciliation.counts,
  );
  expect(afterComparison.reconciliation.verificationStatus).toBe("unverified");
  const evidenceDb = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const [audit] =
      await evidenceDb`SELECT count(*)::int AS count FROM audit_events WHERE workspace_id=${operator.workspaceId} AND action='listing.shopline_import_result_recorded'`;
    expect(audit!.count).toBe(3);
    const [comparisonAudit] =
      await evidenceDb`SELECT count(*)::int AS count FROM audit_events WHERE workspace_id=${operator.workspaceId} AND action='shopline.export_snapshot_compared'`;
    expect(comparisonAudit!.count).toBe(2);
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
  // Task 9: explicitly select the older matching comparison, despite a newer one.
  await compare.getByRole("button", { name: /matching-snapshot.xlsx/ }).click();
  const packet = compare.getByRole("region", {
    name: "Evidence packet",
    exact: true,
  });
  const previewButton = packet.getByRole("button", {
    name: "Preview evidence packet",
    exact: true,
  });
  const downloadButton = packet.getByRole("button", {
    name: "Download evidence JSON",
    exact: true,
  });
  const packetPath = `/api/listings/export/${attemptId}/evidence-packet`;
  await expect(downloadButton).toBeDisabled();
  const previewResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === packetPath &&
      r.request().method() === "GET",
  );
  await previewButton.click();
  const previewHttp = await previewResponse;
  expect(previewHttp.status()).toBe(200);
  expect(new URL(previewHttp.url()).searchParams.get("comparisonId")).toBe(
    matchingRecord.id,
  );
  const reviewed = await previewHttp.json();
  expect(reviewed).toMatchObject({
    comparisonId: matchingRecord.id,
    exportAttemptId: attemptId,
    receiptRevisionCount: 3,
    unreportedMemberCount: 0,
  });
  expect(reviewed.payload).toBeUndefined();
  const repeatedPreview = await page.request.get(
    packetPath + "?comparisonId=" + matchingRecord.id,
  );
  expect((await repeatedPreview.json()).snapshotSha256).toBe(
    reviewed.snapshotSha256,
  );
  const auditConnection = postgres(ADMIN_URL, { max: 1, prepare: false });
  const auditState = async () =>
    await auditConnection`SELECT action,count(*)::int AS count FROM audit_events WHERE workspace_id=${operator.workspaceId} GROUP BY action ORDER BY action`;
  try {
    const beforePacketAudit = await auditState();
    expect(
      beforePacketAudit.some(
        (row) => row.action === "shopline.export_evidence_packet_downloaded",
      ),
    ).toBe(false);
    // A genuine append-only receipt correction after preview must make POST stale.
    const currentMember = detail.reconciliation.members.find(
      (member: { listingId: string }) => member.listingId === listingIds[1],
    );
    const corrected = await page.request.post(
      `/api/listings/${listingIds[1]}/shopline-import-result`,
      {
        data: {
          mode: "export",
          outcome: "accepted",
          exportAttemptId: attemptId,
          versionId: currentMember.versionId,
          supersedesResultId: committedCorrection!.id,
          correctionReason: "Synthetic evidence-packet stale-preview check",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    );
    expect(corrected.status()).toBe(201);
    const correction = (await corrected.json()).result;
    const staleResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === packetPath &&
        r.request().method() === "POST",
    );
    await downloadButton.click();
    const stale = await staleResponse;
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "evidence_snapshot_changed",
    });
    expect(stale.request().postDataJSON()).toEqual({
      comparisonId: matchingRecord.id,
      expectedSnapshotSha256: reviewed.snapshotSha256,
    });
    await expect(packet.getByRole("alert")).toContainText(
      "Refresh the preview and review",
    );
    await expect(downloadButton).toBeDisabled();
    await expect(
      compare.locator(`[data-verification-id="${matchingRecord.id}"]`),
    ).toBeVisible();
    await previewButton.click();
    await expect(downloadButton).toBeEnabled();
    // Retryable unavailable response preserves the reviewed identity.
    await page.route(
      "**" + packetPath,
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ code: "evidence_packet_unavailable" }),
        }),
      { times: 1 },
    );
    await downloadButton.click();
    await expect(packet.getByRole("alert")).toContainText("Please retry");
    await expect(downloadButton).toBeEnabled();
    const beforeDownloadAudit = await auditState();
    const downloadEvent = page.waitForEvent("download");
    const downloadResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === packetPath &&
        r.request().method() === "POST",
    );
    await downloadButton.click();
    const download = await downloadEvent,
      downloadHttp = await downloadResponse;
    expect(downloadHttp.status()).toBe(200);
    expect(downloadHttp.headers()["cache-control"]).toBe("no-store");
    expect(downloadHttp.headers()["content-disposition"]).toContain(
      `export-${attemptId}-comparison-${matchingRecord.id}-evidence.json`,
    );
    expect(download.suggestedFilename()).toBe(
      `export-${attemptId}-comparison-${matchingRecord.id}-evidence.json`,
    );
    const jsonBytes = await readFile((await download.path())!);
    expect(jsonBytes.byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
    const envelope = JSON.parse(jsonBytes.toString("utf8"));
    // Independent canonicalization: no production helper imported.
    const sorted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sorted)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [
                  key,
                  sorted((value as Record<string, unknown>)[key]),
                ]),
            )
          : value;
    expect(
      createHash("sha256")
        .update(JSON.stringify(sorted(envelope.payload)))
        .digest("hex"),
    ).toBe(envelope.payloadSha256);
    expect(jsonBytes.toString("utf8")).toBe(JSON.stringify(sorted(envelope)));
    const { asOf: _asOf, ...snapshotPayload } = envelope.payload;
    expect(
      createHash("sha256")
        .update(JSON.stringify(sorted(snapshotPayload)))
        .digest("hex"),
    ).toBe(downloadHttp.request().postDataJSON().expectedSnapshotSha256);
    expect(envelope.payload.attempt).toMatchObject({
      id: attemptId,
      artifactSha256: matchingRecord.artifactSha256,
    });
    expect(envelope.payload.comparison).toMatchObject({
      id: matchingRecord.id,
      exportAttemptId: attemptId,
      suppliedSha256: matchingRecord.suppliedSha256,
    });
    expect(envelope.payload.comparison.id).not.toBe(committedComparison!.id);
    expect(envelope.payload.limitations).toEqual({
      suppliedSnapshot: true,
      storeAndTime: "operator_attested",
      evidence: "normalized_cells_only",
      quantityDeltas: "observational",
      authenticatedLiveShoplineState: false,
      causalityClaim: false,
      stockNeutralityClaim: false,
      uatSignOff: false,
      merchantWriteAuthorization: false,
    });
    for (const member of envelope.payload.members) {
      const binding = matchingRecord.provenance.evidence.find(
        (e: { listingId: string }) => e.listingId === member.listingId,
      );
      expect(member).toMatchObject(binding);
      const priorMember = detail.reconciliation.members.find(
        (m: { listingId: string }) => m.listingId === member.listingId,
      );
      const expectedHistory = [
        ...priorMember.history,
        ...(member.listingId === listingIds[1] ? [correction] : []),
      ].sort((a, b) => a.revision - b.revision);
      expect(member.receipts.map((r: { id: string }) => r.id)).toEqual(
        expectedHistory.map((r) => r.id),
      );
      member.receipts.forEach((r: Record<string, unknown>, index: number) => {
        expect(r).toMatchObject({
          listingId: member.listingId,
          versionId: member.versionId,
          exportAttemptId: attemptId,
          revision: index + 1,
          supersedesResultId:
            index === 0 ? null : member.receipts[index - 1].id,
        });
        expect(r.recordedBy).toBeTruthy();
        expect(r.createdAt).toBeTruthy();
      });
      expect(member.operatorOutcome).toBe("accepted");
    }
    expect(
      envelope.payload.members.flatMap(
        (m: { receipts: unknown[] }) => m.receipts,
      ),
    ).toHaveLength(4);
    const afterDownloadAudit = await auditState();
    expect(
      afterDownloadAudit.filter(
        (row) => row.action !== "shopline.export_evidence_packet_downloaded",
      ),
    ).toEqual(beforeDownloadAudit);
    expect(
      afterDownloadAudit.find(
        (row) => row.action === "shopline.export_evidence_packet_downloaded",
      )?.count,
    ).toBe(1);
    const [downloadAudit] =
      await auditConnection`SELECT metadata FROM audit_events WHERE workspace_id=${operator.workspaceId} AND action='shopline.export_evidence_packet_downloaded'`;
    expect(Object.keys(downloadAudit!.metadata).sort()).toEqual(
      [
        "comparisonId",
        "exportAttemptId",
        "payloadSha256",
        "schemaVersion",
        "snapshotSha256",
      ].sort(),
    );
    expect(downloadAudit!.metadata).toEqual({
      comparisonId: matchingRecord.id,
      exportAttemptId: attemptId,
      payloadSha256: envelope.payloadSha256,
      schemaVersion: "wukong-attempt-evidence-packet/v1",
      snapshotSha256: downloadHttp.request().postDataJSON()
        .expectedSnapshotSha256,
    });
    const afterPacket = await (
      await page.request.get("/api/listings/export/" + attemptId)
    ).json();
    expect(afterPacket.attempt).toEqual(afterComparison.attempt);
    expect(afterPacket.reconciliation.counts).toEqual(
      afterComparison.reconciliation.counts,
    );
    expect(
      (
        await (
          await page.request.get(comparisonPath + "?page=1&pageSize=10")
        ).json()
      ).total,
    ).toBe(2);
    // Selection change removes the old preview and cannot immediately download.
    await compare.getByRole("button", { name: /changed-missing.xlsx/ }).click();
    await expect(downloadButton).toBeDisabled();
    await compare
      .getByRole("button", { name: /matching-snapshot.xlsx/ })
      .click();
    await expect(downloadButton).toBeDisabled();
  } finally {
    await auditConnection.end();
  }
  const qualityResponse = await page.request.get("/api/quality");
  expect(qualityResponse.status()).toBe(200);
  const qualityMetrics = (await qualityResponse.json()).reviewMetrics;
  // Two generated versions and two saved versions; each saved version was approved.
  expect(qualityMetrics.approvalFraction).toMatchObject({
    numerator: 2,
    denominator: 4,
    value: 0.5,
  });
  // Each saved version changed only the allowed Traditional Chinese name field.
  expect(qualityMetrics.humanEditedFieldFraction).toMatchObject({
    numerator: 2,
    denominator: 16,
    value: 0.125,
  });
  expect(qualityMetrics.creationToApprovalMs.denominator).toBe(2);
  expect(qualityMetrics.creationToApprovalMs.value).toBeGreaterThanOrEqual(0);
  await captureDeliveryLocaleMatrix(page, testInfo, listingIds[0]!, attemptId);
  expect(pageErrors).toEqual([]);
});

test("admin sets up a store inline without losing the selected workbook", async ({
  page,
}, testInfo) => {
  const setupFixture = await prepareBulkImportFixture();
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`UPDATE memberships SET role='admin' WHERE workspace_id=${setupFixture.workspaceId} AND user_id=${setupFixture.userId}`;
    await page.route(
      "**/api/workspace/import-setup",
      async (route) => {
        const response = await route.fetch();
        const summary = await response.json();
        await route.fulfill({
          response,
          json: { ...summary, credentialStorageConfigured: false },
        });
      },
      { times: 1 },
    );
    await signInBulkImportOperator(page, setupFixture);
    const file = page.locator("#bulk-import-file");
    const time = page.locator("#merchant-attested-export-at");
    const submit = page.getByRole("button", { name: "開始匯入 Import" });
    await file.setInputFiles({
      name: filename,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: workbook,
    });
    await time.fill("2026-01-01T00:15");
    await expect(submit).toBeDisabled();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(
      page.getByText(/credential storage|憑證儲存/i).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /Refresh status|重新整理狀態/ })
      .click();
    await page.getByRole("button", { name: /Set up store|設定商店/ }).click();
    await expect(page.locator("form form")).toHaveCount(0);
    await page.getByRole("button", { name: /Close setup|關閉設定/ }).click();
    await expect(time).toHaveValue("2026-01-01T00:15");
    expect(
      await file.evaluate((el: HTMLInputElement) => el.files?.[0]?.name),
    ).toBe(filename);
    await page.getByRole("button", { name: /Set up store|設定商店/ }).click();
    await page
      .getByLabel("SHOPLINE 商店網域 SHOPLINE shop domain")
      .fill("synthetic-inline-store.invalid");
    await page
      .getByLabel("SHOPLINE 存取權杖 SHOPLINE access token")
      .fill("synthetic-token-no-provider-access");
    await page.setViewportSize({ width: 375, height: 812 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("inline-store-setup-en-mobile.png"),
      fullPage: true,
    });
    const connected = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/workspace/connection" &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "連線 Connect", exact: true })
      .click();
    expect((await connected).status()).toBe(200);
    await expect(submit).toBeEnabled();
    await expect(
      page.getByText("synthetic-inline-store.invalid", { exact: true }),
    ).toBeVisible();
    await expect(time).toHaveValue("2026-01-01T00:15");
    expect(
      await file.evaluate((el: HTMLInputElement) => el.files?.[0]?.name),
    ).toBe(filename);
    const imported = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/listings/import",
    );
    await submit.click();
    expect((await imported).status()).toBe(201);
    const [source] =
      await admin`SELECT workbook_sha256 FROM source_imports WHERE workspace_id=${setupFixture.workspaceId}`;
    expect(source!.workbook_sha256).toBe(
      createHash("sha256").update(workbook).digest("hex"),
    );
    const [audit] =
      await admin`SELECT count(*)::int n FROM audit_events WHERE workspace_id=${setupFixture.workspaceId} AND action='workspace.connection_created'`;
    expect(audit!.n).toBe(1);
    for (const locale of ["en", "zh-Hant"]) {
      await page
        .context()
        .addCookies([
          { name: "locale", value: locale, url: "http://127.0.0.1:49217" },
        ]);
      await page.reload();
      await expect(
        page.getByText("synthetic-inline-store.invalid", { exact: true }),
      ).toBeVisible();
      for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          )
          .toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`inline-store-${locale}-${width}.png`),
          fullPage: true,
        });
      }
    }
  } finally {
    await admin.end();
  }
});
