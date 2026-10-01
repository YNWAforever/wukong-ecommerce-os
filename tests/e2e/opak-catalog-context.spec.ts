import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "../../packages/db/src/client.js";
import { emptyWorkingListing } from "../../packages/core/src/index.js";
import {
  BULK_FORM_COLUMNS,
  prepareWorkbookBase,
  hashBulkFormHeaderContract,
} from "../../packages/shopline/src/index.js";
import {
  ADMIN_URL,
  RUNTIME_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";

test("catalog restores zero-prefixed search/page/selection and reference drawer at desktop and mobile", async ({
  page,
}, info) => {
  test.skip(
    process.env.WUKONG_OPAK_E2E !== "1",
    "Dedicated synthetic Opak acceptance required.",
  );
  for (const target of [
    ADMIN_URL,
    RUNTIME_URL,
    String(info.project.use.baseURL),
  ])
    expect(["127.0.0.1", "localhost"]).toContain(new URL(target).hostname);
  expect(new URL(ADMIN_URL).pathname).toMatch(/^\/opak_fixes_/);
  const fixture = await prepareBulkImportFixture();
  const db = createDatabase(RUNTIME_URL, { migrationUrl: ADMIN_URL });
  try {
    await db.forWorkspace(fixture.workspaceId, async (repos) => {
      for (let index = 0; index < 30; index++) {
        const draft = await repos.listings.create({ target: "shopline" });
        await repos.listingInputs.initialize(
          {
            listingId: draft.id,
            actorId: fixture.userId,
            workingContent: {
              ...emptyWorkingListing(),
              sku: index === 0 ? "000674" : String(index).padStart(6, "0"),
              title: { en: "Synthetic catalog " + index, "zh-Hant": "" },
            },
          },
          {
            workspaceId: fixture.workspaceId,
            actorId: fixture.userId,
            entityId: draft.id,
          },
          repos.audit,
        );
      }
      const values: Record<string, string> = {
        productId: "synthetic-reference-000674",
        sku: "000674",
        nameEn: "Synthetic readonly reference",
        regularPrice: "100",
        quantity: "6",
        updateQuantity: "+0",
      };
      const sheet = [
        BULK_FORM_COLUMNS.map((column) => column.en),
        BULK_FORM_COLUMNS.map((column) => column.zh),
        BULK_FORM_COLUMNS.map((column) => values[column.key] ?? ""),
      ];
      await repos.workbookCatalog.save({
        filename: "synthetic-context.xlsx",
        sheetName: "Sheet1",
        actorId: fixture.userId,
        workbookSha256: createHash("sha256")
          .update(JSON.stringify(sheet))
          .digest("hex"),
        headerContractSha256: hashBulkFormHeaderContract(),
        prepared: prepareWorkbookBase(sheet, "synthetic-context.xlsx"),
      });
    });
    await signInBulkImportOperator(page, fixture);
    await page.setViewportSize({ width: 1348, height: 926 });
    await page.goto("/catalog");
    await expect(page.locator("tbody tr")).toHaveCount(25);
    await expect(page.getByRole("searchbox")).toBeInViewport();
    const visible = await page
      .locator("tbody tr")
      .evaluateAll(
        (rows) =>
          rows.filter(
            (row) => row.getBoundingClientRect().bottom <= window.innerHeight,
          ).length,
      );
    expect(visible).toBeGreaterThanOrEqual(5);
    await expect(
      page.getByText("0 selected for Bulk Update", { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator("tbody tr")).toHaveCount(6);
    const calls: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/catalog")
        calls.push(request.url());
    });
    const before = calls.length;
    await page.getByRole("searchbox").fill("000");
    await page.waitForTimeout(100);
    await page.getByRole("searchbox").fill("000674");
    await page.waitForTimeout(150);
    expect(calls).toHaveLength(before);
    await expect(page).toHaveURL(/q=000674/);
    await expect(page.locator("tbody tr")).toHaveCount(2);
    expect(
      calls
        .filter((value) => new URL(value).searchParams.get("q") === "000674")
        .every((value) => new URL(value).searchParams.get("page") === "1"),
    ).toBe(true);
    await page
      .getByRole("checkbox", {
        name: "Select 000674 for Bulk Update",
        exact: true,
      })
      .check();
    const openDraft = page.getByRole("link", {
      name: "Open draft",
      exact: true,
    });
    await openDraft.scrollIntoViewIfNeeded();
    const rememberedScroll = await page.evaluate(() => window.scrollY);
    await openDraft.click();
    await expect(
      page.getByRole("link", { name: "Return to catalog", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Return to catalog", exact: true })
      .click();
    await expect(page.getByRole("searchbox")).toHaveValue("000674");
    await expect(
      page.getByRole("checkbox", {
        name: "Select 000674 for Bulk Update",
        exact: true,
      }),
    ).toBeChecked();
    await expect
      .poll(async () =>
        Math.abs(
          (await page.evaluate(() => window.scrollY)) - rememberedScroll,
        ),
      )
      .toBeLessThanOrEqual(2);
    await page
      .getByRole("button", { name: "Clear selection", exact: true })
      .click();
    await page.getByRole("button", { name: "Workbook", exact: true }).click();
    const trigger = page.getByRole("button", {
      name: "View details",
      exact: true,
    });
    await trigger.click();
    await expect(
      page.getByRole("dialog", {
        name: "Workbook product details",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Close details" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await mkdir(resolve("node_modules/.opak-evidence"), { recursive: true });
    await page.screenshot({
      path: resolve("node_modules/.opak-evidence/catalog-context-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("searchbox")).toHaveValue("000674");
    await trigger.click();
    const dialog = page.getByRole("dialog");
    const box = await dialog.boundingBox();
    expect(box?.width).toBe(390);
    await expect(
      dialog.getByText("synthetic-context.xlsx", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Close details" }).click();
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(/q=000674/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: resolve("node_modules/.opak-evidence/catalog-context-mobile.png"),
    });
  } finally {
    await db.close();
  }
});
