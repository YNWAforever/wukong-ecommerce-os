import {
  expect,
  test,
  type Page,
  type Request,
  type Locator,
} from "@playwright/test";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { BULK_FORM_COLUMNS } from "../../packages/shopline/src/bulk-form.js";
import { writeBulkFormWorkbook } from "../../packages/shopline/src/bulk-form-xlsx.js";
import {
  assertNoHorizontalOverflow,
  localBrowserUrl,
} from "./catalog-usability-checks.js";
import {
  ADMIN_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";

// Synthetic bytes only. Every test owns a new localhost workspace with no connection.
test.describe.configure({ mode: "serial" });
const datedName = "synthetic-BulkUpdateForm-2026-05-21-15-50_0.xlsx";
const renamedName = "合成目錄 renamed &+?#.xlsx";
const evidenceDir = resolve("node_modules/.workbook-evidence");
const mimeType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const rows = Array.from({ length: 23 }, (_, index) => ({
  productId: `synthetic-product-${String(index + 1).padStart(4, "0")}`,
  sku: String(index + 1).padStart(4, "0"),
  nameEn: `Synthetic wine ${index + 1}`,
  nameZh: `合成葡萄酒 ${index + 1}`,
  regularPrice: "128.5",
  quantity: "6",
  updateQuantity: "+0",
  variantId: "",
  onlineStoreCategories: "Wine",
  slKey1: `synthetic-locked-${index + 1}`,
}));
const allRows = [
  ...rows,
  {
    ...rows[0]!,
    productId: "synthetic-excluded",
    sku: "EXCLUDED",
    variantId: "synthetic-variant",
  },
];
const workbook = Buffer.from(
  writeBulkFormWorkbook([
    BULK_FORM_COLUMNS.map((column) => column.en),
    BULK_FORM_COLUMNS.map((column) => column.zh),
    ...allRows.map((row) =>
      BULK_FORM_COLUMNS.map(
        (column) => row[column.key as keyof typeof row] ?? "",
      ),
    ),
  ]),
);
// A separate warning fixture verifies that issue disclosure does not bury Import.
const warningWorkbook = Buffer.from(
  writeBulkFormWorkbook([
    BULK_FORM_COLUMNS.map((column) => column.en),
    BULK_FORM_COLUMNS.map((column) => column.zh),
    ...allRows.map((row) =>
      BULK_FORM_COLUMNS.map((column) =>
        column.key === "onlineStoreCategories"
          ? ""
          : (row[column.key as keyof typeof row] ?? ""),
      ),
    ),
  ]),
);
let fixture: Awaited<ReturnType<typeof prepareBulkImportFixture>>;

test.beforeEach(async () => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1",
    "Set PLAYWRIGHT_E2E=1 with isolated local test services.",
  );
  fixture = await prepareBulkImportFixture();
  await mkdir(evidenceDir, { recursive: true });
});

function captureRequests(page: Page) {
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  return requests;
}
function assertBaseRequests(requests: Request[]) {
  expect(
    requests.filter(
      (request) =>
        !["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(request.url()).hostname,
        ),
    ),
  ).toEqual([]);
  const api = requests.filter((request) =>
    new URL(request.url()).pathname.startsWith("/api/"),
  );
  expect(
    api.filter((request) =>
      /connection|\/api\/listings\/import|\/api\/website-scans|\/api\/enrichment/.test(
        new URL(request.url()).pathname,
      ),
    ),
  ).toEqual([]);
  const uploads = api.filter((request) =>
    new URL(request.url()).pathname.startsWith("/api/workbook-imports"),
  );
  expect(uploads.length).toBeGreaterThan(0);
  for (const request of uploads) {
    expect([...new URL(request.url()).searchParams.keys()]).toEqual([
      "filename",
    ]);
    expect(JSON.stringify(request.headers())).not.toMatch(
      /merchantAttestedExportAt|freshnessAttested|connectionId/i,
    );
    expect(request.headers()["content-type"]).toBe(mimeType);
  }
  expect(
    api.filter(
      (request) =>
        request.method() === "POST" &&
        !/\/api\/auth\/|\/api\/workbook-imports/.test(
          new URL(request.url()).pathname,
        ),
    ),
  ).toEqual([]);
}
async function choose(page: Page, name = datedName) {
  // Attend the chooser before measuring the post-selection action. setInputFiles
  // itself does not scroll like a user navigating to this part of a long page.
  await page
    .locator("#workbook-import-file")
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect(page.locator("#workbook-import-file")).toBeInViewport();
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/workbook-imports/preview",
  );
  await page
    .locator("#workbook-import-file")
    .setInputFiles({ name, mimeType, buffer: workbook });
  const preview = await response;
  expect(preview.status()).toBe(200);
  expect(preview.headers()["cache-control"]).toBe("no-store");
  const body = await preview.json();
  expect(body).toMatchObject({
    totalRows: 24,
    eligibleProducts: 23,
    excludedRows: 1,
    totalIssues: 1,
    workbookSha256: createHash("sha256").update(workbook).digest("hex"),
  });
  expect(body.products).toHaveLength(20);
  expect(body.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "variant_row_blocked",
        severity: "error",
      }),
    ]),
  );
  return body;
}
async function controlGeometry(control: Locator) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      usable:
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        Boolean(hit && (hit === element || element.contains(hit))),
      bounds: {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      },
      scrollY: window.scrollY,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      centerHit: hit?.tagName ?? null,
      fixedNavigation: [...document.querySelectorAll("nav, [role=navigation]")]
        .filter((nav) => getComputedStyle(nav).position === "fixed")
        .map((nav) => {
          const box = nav.getBoundingClientRect();
          return {
            top: box.top,
            bottom: box.bottom,
            left: box.left,
            right: box.right,
          };
        }),
    };
  });
}
async function save(page: Page, label = "Import 23 products") {
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/workbook-imports",
  );
  await page.getByRole("button", { name: label, exact: true }).click();
  const saved = await response;
  expect(saved.status()).toBe(201);
  expect(saved.headers()["cache-control"]).toBe("no-store");
  const result = await saved.json();
  const catalogLink = page.getByRole("link", {
    name: /^(View catalog|查看商品目錄)$/,
  });
  await expect
    .poll(async () => (await controlGeometry(catalogLink)).usable)
    .toBe(true);
  await expect(
    page.locator('[role="status"]').filter({ has: catalogLink }),
  ).toBeInViewport();
  return result;
}
async function sideEffects() {
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const [counts] = await admin`SELECT
      (SELECT count(*)::int FROM shopline_connections WHERE workspace_id=${fixture.workspaceId}) AS connections,
      (SELECT count(*)::int FROM listing_drafts WHERE workspace_id=${fixture.workspaceId}) AS listings,
      (SELECT count(*)::int FROM source_imports WHERE workspace_id=${fixture.workspaceId}) AS connected_imports,
      (SELECT count(*)::int FROM export_attempts WHERE workspace_id=${fixture.workspaceId}) AS export_attempts,
      (SELECT count(*)::int FROM publish_jobs WHERE workspace_id=${fixture.workspaceId}) AS publish_jobs,
      (SELECT count(*)::int FROM source_assets WHERE workspace_id=${fixture.workspaceId}) AS assets`;
    return counts;
  } finally {
    await admin.end();
  }
}
async function artifactKeys() {
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
  try {
    const result = await client.send(
      new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET }),
    );
    expect(result.IsTruncated).toBe(false);
    return (result.Contents ?? []).map((object) => object.Key).sort();
  } finally {
    client.destroy();
  }
}

test("automatic sample imports all eligible products, retains excluded evidence, and refuses real saved IDs for reviewer exports", async ({
  page,
}) => {
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`UPDATE memberships SET role='reviewer' WHERE workspace_id=${fixture.workspaceId} AND user_id=${fixture.userId}`;
    const before = await sideEffects();
    expect(Object.values(before!)).toEqual([0, 0, 0, 0, 0, 0]);
    const artifactsBefore = await artifactKeys();
    const requests = captureRequests(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await signInBulkImportOperator(page, fixture);
    await expect(page.locator("#merchant-attested-export-at")).toHaveCount(0);
    await expect(
      page.locator("#connected-shopline-update"),
    ).not.toHaveAttribute("open", "");
    const preview = await choose(page);
    await expect(
      page.getByText("24 rows · 23 eligible · 1 excluded · 1 issues", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: /^(Product preview|商品預覽)$/ }),
    ).toHaveAccessibleDescription(/showing 20 of 23 products/);
    await expect(page.locator("table tbody tr")).toHaveCount(20);
    const issues = page.locator("details").filter({
      has: page.getByText("Row issues: 1 · 1 excluded", { exact: true }),
    });
    await expect(issues).not.toHaveAttribute("open", "");
    await expect(
      page.getByRole("button", { name: "Import 23 products", exact: true }),
    ).toBeInViewport();
    await issues.locator("summary").click();
    await expect(page.getByText(/Variant rows unsupported/)).toBeVisible();
    expect(
      await admin`SELECT id FROM workbook_imports WHERE workspace_id=${fixture.workspaceId}`,
    ).toHaveLength(0);
    await page.getByText("Source details", { exact: true }).click();
    await expect(
      page.getByText(
        "2026-05-21T15:50 (inferred from filename; timezone unknown, unverified)",
      ),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(evidenceDir, "dated-preview-en-1440.png"),
      fullPage: true,
    });
    const result = await save(page);
    expect(result).toMatchObject({
      importedProducts: 23,
      alreadyImportedProducts: 0,
      excludedRows: 1,
    });
    const saveRequest = requests.find(
      (request) => new URL(request.url()).pathname === "/api/workbook-imports",
    )!;
    expect(saveRequest.headers()["x-workbook-sha256"]).toBe(
      preview.workbookSha256,
    );
    expect(saveRequest.headers()["x-workbook-header-sha256"]).toBe(
      preview.headerContractSha256,
    );
    const [source] =
      await admin`SELECT filename, normalized_sheet, inferred_export_time FROM workbook_imports WHERE id=${result.importId} AND workspace_id=${fixture.workspaceId}`;
    expect(source!.filename).toBe(datedName);
    expect(source!.inferred_export_time).toEqual({
      value: "2026-05-21T15:50",
      source: "filename",
      timeZone: null,
    });
    expect(source!.normalized_sheet).toHaveLength(26);
    expect(JSON.stringify(source!.normalized_sheet)).toContain(
      "synthetic-variant",
    );
    const products =
      await admin`SELECT id,product FROM workbook_products WHERE workspace_id=${fixture.workspaceId} ORDER BY row_number`;
    expect(products).toHaveLength(23);
    expect(products[22]!.product).toMatchObject({
      productId: "synthetic-product-0023",
      sku: "0023",
    });
    await page.getByRole("link", { name: "View catalog", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "View details", exact: true }),
    ).toHaveCount(23);
    await expect(page.locator("tbody input[type=checkbox]")).toHaveCount(0);
    const catalog = await page.request.get(
      "/api/catalog?filter=workbook&page=1&pageSize=25",
    );
    expect(catalog.status()).toBe(200);
    expect(await catalog.json()).toMatchObject({
      totalMatching: 23,
      summary: { workbook: 23 },
    });
    await page
      .getByLabel("Search catalog", { exact: true })
      .fill("synthetic-product-0023");
    await expect(
      page.getByRole("button", { name: "View details", exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "View details", exact: true })
      .click();
    const detail = page.getByRole("region", {
      name: "Workbook product details",
      exact: true,
    });
    await expect(detail).toContainText("Synthetic wine 23");
    await expect(detail).toContainText("合成葡萄酒 23");
    await expect(detail).toContainText("128.5");
    await expect(detail).toContainText(datedName);
    await expect(detail).toContainText("unavailable for export or publication");
    await page.screenshot({
      path: resolve(evidenceDir, "catalog-detail-en-1440.png"),
      fullPage: true,
    });
    await page.goto("/listings/import");
    await page.getByRole("tab", { name: "Workbook", exact: true }).click();
    await choose(page, renamedName);
    const replay = await save(page);
    expect(replay).toEqual({
      ...result,
      importedProducts: 0,
      alreadyImportedProducts: 23,
    });
    await expect(page.getByRole("status")).toContainText(
      "0 imported · 23 already imported · 1 excluded",
    );
    expect(
      await admin`SELECT id FROM workbook_imports WHERE workspace_id=${fixture.workspaceId}`,
    ).toHaveLength(1);
    expect(
      await admin`SELECT id FROM workbook_products WHERE workspace_id=${fixture.workspaceId}`,
    ).toHaveLength(23);
    assertBaseRequests(requests);
    const id = products[22]!.id;
    const exported = await page.request.post("/api/listings/export", {
      data: { listingIds: [id], freshnessAttested: true },
    });
    expect(exported.status()).toBe(200);
    expect(await exported.json()).toMatchObject({
      rowCount: 0,
      exportAttemptId: null,
      manifest: [{ listingId: id, outcome: "listing_not_found" }],
    });
    for (const method of ["csv", "bulk_form", "shopline_api"]) {
      const response = await page.request.post(`/api/listings/${id}/deliver`, {
        data: { method, freshnessAttested: true },
      });
      expect([404, 409]).toContain(response.status());
      expect(await response.json()).toMatchObject({
        code: "listing_not_found",
      });
    }
    expect(await sideEffects()).toEqual(before);
    expect(await artifactKeys()).toEqual(artifactsBefore);
    expect(errors).toEqual([]);
  } finally {
    await admin.end();
  }
});

test("renamed workbook with unknown date retains its file across tabs and retries failed preview and save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const requests = captureRequests(page);
  await signInBulkImportOperator(page, fixture);
  await page.route(
    "**/api/workbook-imports/preview?**",
    (route) => route.abort("failed"),
    { times: 1 },
  );
  await page
    .locator("#workbook-import-file")
    .setInputFiles({ name: renamedName, mimeType, buffer: warningWorkbook });
  await expect(
    page
      .getByRole("region", { name: "Workbook product import", exact: true })
      .getByRole("alert"),
  ).toContainText("Unable to complete this request. Please retry.");
  await page.getByRole("tab", { name: "Workbook", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("tab", { name: "Website", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  expect(
    await page
      .locator("#workbook-import-file")
      .evaluate((element: HTMLInputElement) => element.files?.[0]?.name),
  ).toBe(renamedName);
  const retryPreview = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/workbook-imports/preview",
  );
  await page
    .getByRole("button", { name: "Retry preview", exact: true })
    .click();
  const retried = await retryPreview;
  expect(retried.status()).toBe(200);
  expect(await retried.json()).toMatchObject({
    totalIssues: 24,
    eligibleProducts: 23,
    excludedRows: 1,
  });
  await expect(
    page.getByRole("table", { name: /^(Product preview|商品預覽)$/ }),
  ).toHaveAccessibleDescription(/showing 20 of 23 products/);
  const warningIssues = page.locator("details").filter({
    has: page.getByText("Row issues: 24 · 1 excluded", { exact: true }),
  });
  await expect(warningIssues).not.toHaveAttribute("open", "");
  await expect(
    page.getByRole("button", { name: "Import 23 products", exact: true }),
  ).toBeInViewport();
  await warningIssues.locator("summary").click();
  await expect(warningIssues.getByText(/Categories missing/)).toHaveCount(23);
  await expect(
    warningIssues.getByText(/Variant rows unsupported/),
  ).toBeVisible();
  await warningIssues.locator("summary").click();
  await page.getByText("Source details", { exact: true }).click();
  await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
  await page
    .getByRole("tab", { name: "Supporting evidence", exact: true })
    .click();
  await page.getByRole("tab", { name: "Workbook", exact: true }).click();
  await expect(
    page.getByRole("table", { name: /^(Product preview|商品預覽)$/ }),
  ).toHaveAccessibleDescription(/showing 20 of 23 products/);
  await page.route(
    "**/api/workbook-imports?**",
    (route) => route.abort("failed"),
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "Import 23 products", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry import", exact: true }),
  ).toBeVisible();
  await expect(page.locator("table tbody tr")).toHaveCount(20);
  await page.screenshot({
    path: resolve(evidenceDir, "retained-save-retry-en-1440.png"),
    fullPage: true,
  });
  const result = await save(page, "Retry import");
  expect(result).toMatchObject({
    importedProducts: 23,
    alreadyImportedProducts: 0,
  });
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const [source] =
      await admin`SELECT filename,inferred_export_time FROM workbook_imports WHERE workspace_id=${fixture.workspaceId}`;
    expect(source).toMatchObject({
      filename: renamedName,
      inferred_export_time: null,
    });
  } finally {
    await admin.end();
  }
  assertBaseRequests(requests);
  expect(Object.values((await sideEffects())!)).toEqual([0, 0, 0, 0, 0, 0]);
});

for (const locale of ["en", "zh-Hant"] as const) {
  for (const width of [375, 1440]) {
    test(`workbook preview, saved catalog and detail in ${locale} at ${width}px`, async ({
      page,
    }, testInfo) => {
      const requests = captureRequests(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 1000 });
      await signInBulkImportOperator(page, fixture);
      await page.context().addCookies([
        {
          name: "locale",
          value: locale,
          url: localBrowserUrl(testInfo.project.use.baseURL),
        },
      ]);
      await page.reload();
      await page
        .getByRole("tab", {
          name: locale === "en" ? "Workbook" : "試算表",
          exact: true,
        })
        .click();
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await choose(page, renamedName);
      await expect(
        page.getByRole("table", { name: /^(Product preview|商品預覽)$/ }),
      ).toHaveAccessibleDescription(
        locale === "en" ? /showing 20 of 23/ : /顯示 20 \/ 23/,
      );
      await expect(page.locator("#merchant-attested-export-at")).toHaveCount(0);
      const importAction = page.getByRole("button", {
        name: locale === "en" ? "Import 23 products" : "匯入 23 個商品",
        exact: true,
      });
      const beforeScroll = await controlGeometry(importAction);
      // Mobile headers can require a normal small scroll from the chooser.
      // Never claim a tiny intersection behind fixed navigation is usable.
      if (!beforeScroll.usable) await page.mouse.wheel(0, 240);
      await expect
        .poll(async () => (await controlGeometry(importAction)).usable)
        .toBe(true);
      const afterScroll = await controlGeometry(importAction);
      await writeFile(
        resolve(evidenceDir, `preview-action-geometry-${locale}-${width}.json`),
        JSON.stringify(
          {
            beforeScroll,
            afterScroll,
            smallScrollNeeded: !beforeScroll.usable,
          },
          null,
          2,
        ),
      );
      await page.screenshot({
        path: resolve(evidenceDir, `preview-action-${locale}-${width}.png`),
        fullPage: false,
      });
      await assertNoHorizontalOverflow(page);
      await page.screenshot({
        path: resolve(evidenceDir, `preview-viewport-${locale}-${width}.png`),
        fullPage: false,
      });
      await page.screenshot({
        path: resolve(evidenceDir, `preview-${locale}-${width}.png`),
        fullPage: true,
      });
      expect(
        await save(
          page,
          locale === "en" ? "Import 23 products" : "匯入 23 個商品",
        ),
      ).toMatchObject({ importedProducts: 23, excludedRows: 1 });
      // Browse real source values across all six columns through the scrollable
      // region. Each cell must be reachable within the region, not merely in DOM.
      const previewTable = page.getByRole("table", {
        name: locale === "en" ? "Product preview" : "商品預覽",
        exact: true,
      });
      const previewRegion = page.getByRole("region", {
        name:
          locale === "en"
            ? "Product preview, horizontally scrollable"
            : "商品預覽，可水平捲動",
        exact: true,
      });
      await previewRegion.focus();
      await expect(previewRegion).toBeFocused();
      if (width === 375) {
        await previewRegion.press("ArrowRight");
        await expect
          .poll(() => previewRegion.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0);
      }
      const firstCells = previewTable.locator("tbody tr").first().locator("td");
      const values = [
        "3",
        "synthetic-product-0001",
        "0001",
        "合成葡萄酒 1",
        "Synthetic wine 1",
        "128.5",
      ];
      for (let index = 0; index < values.length; index++) {
        const cell = firstCells.nth(index);
        await cell.scrollIntoViewIfNeeded();
        await expect(cell).toHaveText(values[index]!);
        const reachable = await cell.evaluate((element) => {
          const cellBounds = element.getBoundingClientRect();
          const regionBounds = element
            .closest('[role="region"]')!
            .getBoundingClientRect();
          return (
            cellBounds.left >= regionBounds.left - 1 &&
            cellBounds.right <= regionBounds.right + 1
          );
        });
        expect(
          reachable,
          `Preview column ${index + 1} must fit within the attended horizontal scroll region`,
        ).toBe(true);
      }
      await page.screenshot({
        path: resolve(evidenceDir, `preview-table-${locale}-${width}.png`),
        fullPage: false,
      });
      if (width === 375) {
        expect(
          await previewRegion.evaluate((element) => element.scrollLeft),
        ).toBeGreaterThan(0);
        await assertNoHorizontalOverflow(page);
        await page.screenshot({
          path: resolve(evidenceDir, `preview-scrolled-${locale}-${width}.png`),
          fullPage: false,
        });
      }
      await page
        .getByRole("link", {
          name: locale === "en" ? "View catalog" : "查看商品目錄",
          exact: true,
        })
        .click();
      const detailButtons = page.getByRole("button", {
        name: locale === "en" ? "View details" : "查看資料",
        exact: true,
      });
      await expect(detailButtons).toHaveCount(23);
      await assertNoHorizontalOverflow(page);
      await page.screenshot({
        path: resolve(evidenceDir, `catalog-${locale}-${width}.png`),
        fullPage: true,
      });
      await detailButtons.first().click();
      const detail = page.getByRole("region", {
        name: locale === "en" ? "Workbook product details" : "試算表商品資料",
        exact: true,
      });
      await expect(detail).toContainText(renamedName);
      await expect(detail).toContainText(
        locale === "en"
          ? "unavailable for export or publication"
          : "不能匯出或發佈",
      );
      await expect(detail.locator("img, a")).toHaveCount(0);
      await assertNoHorizontalOverflow(page);
      await page.screenshot({
        path: resolve(evidenceDir, `detail-${locale}-${width}.png`),
        fullPage: true,
      });
      assertBaseRequests(requests);
    });
  }
}
