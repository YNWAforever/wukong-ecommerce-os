import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  ADMIN_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";
import { BULK_FORM_COLUMNS } from "../../packages/shopline/src/bulk-form.js";
import { writeBulkFormWorkbook } from "../../packages/shopline/src/bulk-form-xlsx.js";

test.describe.configure({ mode: "default" });
let fixture: Awaited<ReturnType<typeof prepareBulkImportFixture>>;
let reviewId: string, exportId: string, scanId: string;
let externalRequests: string[] = [];
test.afterEach(() => {
  expect(externalRequests).toEqual([]);
});
async function seed() {
  const db = postgres(ADMIN_URL, { max: 1, prepare: false });
  reviewId = randomUUID();
  exportId = randomUUID();
  scanId = randomUUID();
  try {
    for (let i = 0; i < 27; i++) {
      const id = i === 26 ? reviewId : randomUUID(),
        version = randomUUID();
      await db`insert into listing_drafts(id,workspace_id,status,updated_at) values (${id},${fixture.workspaceId},${i === 26 ? "in_review" : "failed"},'2026-09-01')`;
      await db`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${version},${fixture.workspaceId},${id},1,${db.json({ sku: "WB-SYNTHETIC", producer: "Synthetic", productType: "wine", country: "France", region: null, vintage: null, grapeVarieties: [], volumeMl: 750, abvPercent: 12, packQuantity: 1, priceHkd: 128, stockQuantity: 6, criticScores: [], awards: [], description: { en: "Synthetic review description", "zh-Hant": "合成審核描述" }, seo: { title: { en: "Synthetic", "zh-Hant": "合成" }, description: { en: "Synthetic", "zh-Hant": "合成" } }, tags: [], imageAssetIds: [], title: { en: `Synthetic task ${i}`, "zh-Hant": `Synthetic task ${i}` } })},${fixture.userId})`;
      await db`update listing_drafts set active_version_id=${version} where id=${id} and workspace_id=${fixture.workspaceId}`;
      if (i === 26) {
        await db`insert into export_attempts(id,workspace_id,idempotency_key,requested_by,manifest,row_count,spec_version,artifact_status,artifact_ready_at,created_at,artifact_sha256,provenance) values (${exportId},${fixture.workspaceId},${randomUUID()},${fixture.userId},${db.json([{ listingId: id, versionId: version, outcome: "included" }])},1,'synthetic','ready','2026-09-02','2026-09-01',${"a".repeat(64)},'{}')`;
      }
    }
    await db`insert into listing_pipeline_runs(workspace_id,listing_id,active_version_sequence,idempotency_key,status) values (${fixture.workspaceId},${reviewId},1,${randomUUID()},'failed')`;
    await db`insert into export_attempts(workspace_id,idempotency_key,requested_by,manifest,row_count,spec_version,artifact_status) values (${fixture.workspaceId},${randomUUID()},${fixture.userId},'[]',0,'synthetic',null)`;
    await db`insert into website_scans(id,workspace_id,requested_url,requested_by,request_key,state,checkpoint,next_eligible_at,deadline_at) values (${scanId},${fixture.workspaceId},'https://synthetic.invalid/partial',${fixture.userId},${randomUUID()},'partial','{"candidateUrls":["https://synthetic.invalid/p"],"preview":{"products":[{"key":"https://synthetic.invalid/p","sourceUrl":"https://synthetic.invalid/p","title":"Synthetic preview bottle","capturedAt":"2026-09-06T00:00:00Z","availability":"unknown","imageUrls":[],"attributes":{},"fieldSources":{"title":"json_ld"},"warnings":[]}],"warnings":["Synthetic partial limitation"]}}',now(),now())`;
  } finally {
    await db.end();
  }
}
async function open(page: Page, query = "state=attention") {
  await page.goto(`/dashboard?${query}`);
  await expect(
    page.getByRole("heading", { name: "Workbench", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Loading workbench…", { exact: true }),
  ).toHaveCount(0);
}
const rows = (page: Page) =>
  page.locator("li").filter({ has: page.getByRole("heading", { level: 3 }) });
test.beforeEach(async ({ page }) => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1",
    "Requires isolated local services",
  );
  externalRequests = [];
  page.on("request", (request) => {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(request.url()).hostname,
      )
    )
      externalRequests.push(request.url());
  });
  fixture = await prepareBulkImportFixture();
  await seed();
  await signInBulkImportOperator(page, fixture, false);
});

test("retained counts exceed a page, exact review/export destinations and Back restoration", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByRole("button", { name: /Needs attention 28 tasks/ }),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  await expect(
    page.getByRole("link", { name: "Status unavailable: 1", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: /Needs attention 28 tasks/ }),
  ).toBeVisible();
  const review = rows(page).filter({ hasText: "Synthetic task 26" });
  await expect(
    review.getByRole("link", { name: "View details" }),
  ).toBeVisible();
  const listingResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/listings/${reviewId}`,
  );
  await review.getByRole("link").click();
  expect((await listingResponse).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Synthetic task 26", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/listings/${reviewId}`));
  await page.getByRole("link", { name: "Return to workbench" }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.route("**/api/jobs?*", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await rows(page)
    .filter({ hasText: "Import result not yet reported" })
    .getByRole("link")
    .click();
  await expect(page).toHaveURL(new RegExp(`attempt=${exportId}`));
  await expect(
    page.locator(`[data-export-attempt-id="${exportId}"]`),
  ).toBeVisible();
  await page.getByRole("link", { name: "Return to workbench" }).click();
  await page.getByRole("button", { name: /Completed 1 tasks/ }).click();
  await expect(page).toHaveURL(/state=completed/);
  await expect(page).not.toHaveURL(/page=2/);
  await page.goBack();
  await expect(page).toHaveURL(/page=2/);
  await expect(rows(page)).toHaveCount(3);
});

test("successful synthetic workbook goes to its exact catalog source and partial scan stays a preview", async ({
  page,
}) => {
  const row = {
    productId: "synthetic-workbench-product",
    sku: "WB-001",
    nameEn: "Workbench synthetic wine",
    nameZh: "工作台合成葡萄酒",
    regularPrice: "128",
    quantity: "6",
    updateQuantity: "+0",
    onlineStoreCategories: "Wine",
    slKey1: "synthetic-lock",
  };
  const buffer = Buffer.from(
    writeBulkFormWorkbook([
      BULK_FORM_COLUMNS.map((c) => c.en),
      BULK_FORM_COLUMNS.map((c) => c.zh),
      BULK_FORM_COLUMNS.map((c) => row[c.key as keyof typeof row] ?? ""),
    ]),
  );
  const preview = await page.request.post(
    "/api/workbook-imports/preview?filename=synthetic-workbench.xlsx",
    {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      data: buffer,
    },
  );
  expect(preview.status()).toBe(200);
  const previewBody = await preview.json();
  const saved = await page.request.post(
    "/api/workbook-imports?filename=synthetic-workbench.xlsx",
    {
      headers: {
        "x-workbook-sha256": previewBody.workbookSha256,
        "x-workbook-header-sha256": previewBody.headerContractSha256,
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      data: buffer,
    },
  );
  expect(saved.status()).toBe(201);
  const body = await saved.json();
  await open(page, "state=completed");
  await expect(
    page.getByRole("button", { name: /Completed 2 tasks/ }),
  ).toBeVisible();
  await rows(page)
    .filter({ hasText: "synthetic-workbench.xlsx" })
    .getByRole("link")
    .click();
  await expect(page).toHaveURL(/filter=workbook&importId=/);
  expect(new URL(page.url()).searchParams.get("importId")).toBe(
    body.importId ?? body.id,
  );
  await expect(
    page.getByText("工作台合成葡萄酒", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Return to workbench" }).click();
  const partial = rows(page).filter({
    hasText: "Partial preview — inspect limitations",
  });
  await expect(partial).toBeVisible();
  await partial.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`scan=${scanId}`));
  await expect(page.getByText(/Partial preview:/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Publish|Export workbook/ }),
  ).toHaveCount(0);
});

test("reviewer and viewer capabilities reflect real membership and return links stay local", async ({
  page,
}) => {
  const db = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await db`update memberships set role='reviewer' where workspace_id=${fixture.workspaceId} and user_id=${fixture.userId}`;
    await open(page, "state=attention&page=2");
    await expect(
      page.getByRole("link", { name: "Review content", exact: true }),
    ).toBeVisible();
    await db`update memberships set role='viewer' where workspace_id=${fixture.workspaceId} and user_id=${fixture.userId}`;
    await open(page, "state=attention&page=2");
    await expect(
      page.getByText("Read-only access. An operator can import products."),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: /Import products|Review content|View and report result/,
      }),
    ).toHaveCount(0);
    await page.goto(
      `/jobs?kind=export&attempt=${exportId}&returnTo=https%3A%2F%2Fevil.invalid`,
    );
    await expect(
      page.getByRole("link", { name: "Return to workbench" }),
    ).toHaveAttribute("href", "/dashboard");
    await page.getByRole("link", { name: "Return to workbench" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  } finally {
    await db.end();
  }
});

test("same-query failures retain stale rows; changed filters hide previous membership and superseded responses", async ({
  page,
}) => {
  await open(page);
  await page.route("**/api/workbench?*", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Stale — showing the last successful observation."),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(25);
  await expect(
    page.getByRole("link", { name: "Status unavailable: 1", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Task source").selectOption("workbook_import");
  await expect(
    page.getByText("Unable to load the workbench. Please retry."),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await page.unroute("**/api/workbench?*");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No tasks match these filters.")).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/workbench?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("kind") === "listing") {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await page.getByLabel("Task source").selectOption("listing");
  await seen;
  await expect(rows(page)).toHaveCount(0);
  await page.getByLabel("Task source").selectOption("website_scan");
  await expect(page.getByText("No tasks match these filters.")).toBeVisible();
  release();
  await expect(page.getByLabel("Task source")).toHaveValue("website_scan");
  await expect(rows(page)).toHaveCount(0);
});

for (const width of [390, 1440])
  test(`responsive ${width}px English/Chinese and keyboard controls`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await expect(
      page.getByRole("button", { name: /Needs attention 28 tasks/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .getByText("tasks · not product count", { exact: true })
        .first()
        .evaluate((el) => {
          const rgb = getComputedStyle(el)
            .color.match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const c = v / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
          return (
            1.05 /
            (0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]! + 0.05)
          );
        }),
    ).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({
      path: info.outputPath(`workbench-${width}-en.png`),
      fullPage: true,
    });
    const completed = page.getByRole("button", { name: /Completed 1 tasks/ });
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
    });
    let reached = false;
    for (let i = 0; i < 35; i++) {
      await page.keyboard.press("Tab");
      if (await completed.evaluate((el) => el === document.activeElement)) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/state=completed/);
    await expect(
      page.getByText("Partial preview — inspect limitations", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      document.cookie = "locale=zh-Hant; path=/; max-age=31536000";
    });
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "工作台", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("部分預覽 — 請查看限制", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`workbench-${width}-zh.png`),
      fullPage: true,
    });
  });
