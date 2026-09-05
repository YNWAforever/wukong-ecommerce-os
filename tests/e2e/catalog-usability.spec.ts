import { expect, test, type Page } from "@playwright/test";
import {
  assertDrawerKeyboardFlow,
  assertNoHorizontalOverflow,
  assertSkipLink,
  localBrowserUrl,
} from "./catalog-usability-checks.js";
import { BULK_FORM_COLUMNS } from "../../packages/shopline/src/bulk-form.js";
import { writeBulkFormWorkbook } from "../../packages/shopline/src/bulk-form-xlsx.js";
import {
  prepareBulkUpdateFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";

async function importSyntheticProduct(page: Page) {
  const values: Record<string, string> = {
    productId: "synthetic-recovery-0002",
    sku: "0002",
    nameEn: "Synthetic recovery product",
    nameZh: "合成復原商品",
    regularPrice: "100",
    quantity: "6",
    updateQuantity: "+0",
  };
  const workbook = Buffer.from(
    writeBulkFormWorkbook([
      BULK_FORM_COLUMNS.map((column) => column.en),
      BULK_FORM_COLUMNS.map((column) => column.zh),
      BULK_FORM_COLUMNS.map((column) => values[column.key] ?? ""),
    ]),
  );
  const imported = await page.request.post(
    "/api/listings/import?" +
      new URLSearchParams({
        merchantAttestedExportAt: new Date().toISOString(),
        filename: "synthetic-recovery.xlsx",
      }),
    {
      data: workbook,
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    },
  );
  expect(imported.status()).toBe(201);
}

test.beforeEach(() => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1",
    "Requires isolated synthetic local services.",
  );
});

test("catalog recovers a failed filtered request without resetting the search", async ({
  page,
}) => {
  page.setDefaultTimeout(10_000);
  const fixture = await prepareBulkUpdateFixture();
  await signInBulkImportOperator(page, fixture);
  await importSyntheticProduct(page);
  await page.goto("/catalog");
  const search = page.getByRole("searchbox");
  await expect(search).toBeVisible();
  let failed = false;
  await page.route("**/api/catalog?**", async (route) => {
    if (
      !failed &&
      new URL(route.request().url()).searchParams.get("q") === "0002"
    ) {
      failed = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "synthetic_transient_failure" }),
      });
      return;
    }
    await route.continue();
  });
  await search.fill("0002");
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  const recovered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/catalog" &&
      new URL(response.url()).searchParams.get("q") === "0002" &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await recovered;
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(search).toHaveValue("0002");
  await expect(page.getByRole("row").filter({ hasText: "0002" })).toHaveCount(
    1,
  );
});

test("read pages support both locales and keyboard navigation at desktop and 375px", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  const baseUrl = localBrowserUrl();
  const fixture = await prepareBulkUpdateFixture();
  await signInBulkImportOperator(page, fixture);
  await importSyntheticProduct(page);
  const catalogResponse = await page.request.get("/api/catalog");
  expect(catalogResponse.status()).toBe(200);
  const importedCatalog = await catalogResponse.json();
  const sourceImportId =
    importedCatalog.items[0].sourceReadiness.sourceImportId;
  expect(sourceImportId).toEqual(expect.any(String));
  const listingsResponse = await page.request.get("/api/listings?pageSize=1");
  expect(listingsResponse.status()).toBe(200);
  const receivedId = (await listingsResponse.json()).items[0].id;
  expect(receivedId).toEqual(expect.any(String));
  const qualityBeforeProcessing = await page.request.get("/api/quality");
  expect(qualityBeforeProcessing.status()).toBe(200);
  const emptyMetrics = (await qualityBeforeProcessing.json()).reviewMetrics;
  for (const metric of [
    emptyMetrics.approvalFraction,
    emptyMetrics.creationToApprovalMs,
    emptyMetrics.humanEditedFieldFraction,
  ]) {
    expect(metric).toMatchObject({
      value: null,
      denominator: 0,
      reason: "no_qualified_evidence",
    });
  }

  await page.goto("/quality");
  const heading = page.locator("main").getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  const englishHeading = await heading.innerText();
  await page.getByTestId("locale-toggle-zh").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(heading).not.toHaveText(englishHeading);
  const chineseHeading = await heading.innerText();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(heading).toHaveText(chineseHeading);
  await page.getByTestId("locale-toggle-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(heading).toHaveText(englishHeading);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const headings = new Map<string, string>();
  for (const locale of ["en", "zh-Hant"] as const) {
    await page
      .context()
      .addCookies([{ name: "locale", value: locale, url: baseUrl }]);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [route, api] of [
        ["catalog", "/api/catalog"],
        ["dashboard", "/api/listings"],
        ["queue", "/api/listings"],
        ["quality", "/api/quality"],
        ["system-map", null],
        ["received-detail", "/api/listings/" + receivedId],
      ] as const) {
        const loaded = api
          ? page.waitForResponse(
              (r) => new URL(r.url()).pathname === api && r.status() === 200,
            )
          : Promise.resolve();
        await page.goto(
          route === "received-detail" ? "/listings/" + receivedId : "/" + route,
        );
        await loaded;
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        const main = page.locator("main");
        await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(main.getByRole("alert")).toHaveCount(0);
        const heading = await main
          .getByRole("heading", { level: 1 })
          .innerText();
        if (locale === "en") headings.set(route, heading);
        else expect(heading).not.toBe(headings.get(route));
        if (
          route === "catalog" ||
          route === "dashboard" ||
          route === "received-detail"
        ) {
          await expect(main).toContainText(sourceImportId);
        }
        if (route === "catalog" && width === 375) {
          const region = main.getByRole("region", {
            name:
              locale === "en"
                ? "Product list, horizontally scrollable"
                : "商品列表，可水平捲動",
            exact: true,
          });
          await region.focus();
          await expect(region).toBeFocused();
          await page.keyboard.press("ArrowRight");
          await expect
            .poll(() => region.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(0);
          await page.keyboard.press("ArrowLeft");
          await expect
            .poll(() => region.evaluate((element) => element.scrollLeft))
            .toBe(0);
        }
        await assertNoHorizontalOverflow(page);
        await assertSkipLink(page);
        if (width === 375) await assertDrawerKeyboardFlow(page);
        await page.screenshot({
          path: testInfo.outputPath(
            "task7-" + route + "-" + locale + "-" + width + ".png",
          ),
          fullPage: true,
        });
      }
    }
  }
});
