import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { emptyWorkingListing } from "../../packages/core/src/index.js";
import { BULK_FORM_COLUMNS } from "../../packages/shopline/src/bulk-form.js";
import { writeBulkFormWorkbook } from "../../packages/shopline/src/bulk-form-xlsx.js";
import {
  ADMIN_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";

test("20 synthetic references enter connected maintenance, replay once and become manual review versions", async ({
  page,
}, info) => {
  test.skip(
    process.env.WUKONG_OPAK_E2E !== "1",
    "Explicit isolated Opak acceptance required.",
  );
  test.setTimeout(180_000);
  const browser = new URL(String(info.project.use.baseURL));
  const database = new URL(ADMIN_URL);
  expect(["127.0.0.1", "localhost"]).toContain(browser.hostname);
  expect(["127.0.0.1", "localhost"]).toContain(database.hostname);
  expect(database.pathname).toMatch(/^\/opak_fixes_[a-z0-9_]+$/);
  const fixture = await prepareBulkImportFixture();
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const values = Array.from({ length: 20 }, (_, index) => ({
    productId: `synthetic-maintenance-${index + 1}`,
    sku: String(index + 1).padStart(4, "0"),
    nameEn: `SYN Estate 2020 750ml 6 bottles ${index + 1}`,
    nameZh: `合成酒莊 2020 750ml 6 bottles ${index + 1}`,
    regularPrice: "128.5",
    quantity: "6",
    updateQuantity: "+0",
  }));
  const workbook = Buffer.from(
    writeBulkFormWorkbook([
      BULK_FORM_COLUMNS.map((c) => c.en),
      BULK_FORM_COLUMNS.map((c) => c.zh),
      ...values.map((row) =>
        BULK_FORM_COLUMNS.map((c) => row[c.key as keyof typeof row] ?? ""),
      ),
    ]),
  );
  const upload = {
    name: "synthetic-maintenance-current.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  };
  try {
    await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values (${fixture.connectionId},${fixture.workspaceId},'synthetic-maintenance.invalid','synthetic-disabled')`;
    await signInBulkImportOperator(page, fixture);
    await page.locator("#workbook-import-file").setInputFiles(upload);
    const referenceSaved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workbook-imports" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Import 20 products", exact: true })
      .click();
    expect((await referenceSaved).status()).toBe(201);
    await page.getByRole("link", { name: "View catalog", exact: true }).click();
    await expect(page).toHaveURL(/\/catalog\?/);
    const referenceCatalog = await (
      await page.request.get("/api/catalog?filter=workbook")
    ).json();
    expect(referenceCatalog.summary).toMatchObject({
      referenceRows: 20,
      drafts: 0,
      boundProducts: 0,
    });
    expect(
      referenceCatalog.items.every(
        (item: { canExport: boolean }) => item.canExport === false,
      ),
    ).toBe(true);
    const reference = referenceCatalog.items.find(
      (item: { sourceProductId: string }) =>
        item.sourceProductId === values[0]!.productId,
    );
    expect(reference).toBeDefined();
    await page.goto(
      `/listings/import?intent=maintain-existing&referenceKind=workbook&referenceId=${reference.id}`,
    );
    await expect(
      page.getByText("synthetic-maintenance.invalid", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Use and check", exact: true })
      .click();
    await expect(page.locator("#maintenance-product-id")).toHaveValue(
      values[0]!.productId,
    );
    await page.locator("#bulk-import-file").setInputFiles(upload);
    await page
      .locator("#merchant-attested-export-at")
      .fill(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16));
    const submit = page.getByRole("button", {
      name: "Start import",
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await page.getByLabel(/I checked the actual product/).check();
    await page.locator("#bulk-source-confirmation").check();
    const imported = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/listings/import" &&
        response.request().method() === "POST",
    );
    await submit.click();
    const response = await imported;
    expect(response.status()).toBe(201);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      createdDrafts: 20,
      replayed: false,
      invalidatedApprovals: 0,
    });
    await expect(page.getByText(/Rows parsed: 20/)).toBeVisible();
    const retried = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/listings/import" &&
        response.request().method() === "POST",
    );
    await submit.click();
    const retry = await retried;
    expect(retry.status()).toBe(200);
    expect(await retry.json()).toMatchObject({
      sourceImportId: receipt.sourceImportId,
      replayed: true,
      alreadyImportedProducts: 20,
      createdDrafts: 0,
    });
    const [counts] =
      await admin`select (select count(*)::int from source_imports where workspace_id=${fixture.workspaceId}) imports,(select count(*)::int from listing_drafts where workspace_id=${fixture.workspaceId}) drafts,(select count(*)::int from source_row_snapshots where workspace_id=${fixture.workspaceId}) sources`;
    expect(counts).toEqual({ imports: 1, drafts: 20, sources: 20 });
    const catalog = await (
      await page.request.get("/api/catalog?filter=drafts&pageSize=100")
    ).json();
    expect(catalog.summary).toMatchObject({
      referenceRows: 20,
      drafts: 20,
      boundProducts: 20,
      total: 40,
    });
    expect(catalog.items).toHaveLength(20);
    for (const [index, item] of catalog.items.entries()) {
      const detail = await (
        await page.request.get(`/api/listings/${item.listingId}`)
      ).json();
      expect(detail).toMatchObject({
        activeVersion: null,
        workingInput: { revision: 1 },
        currentRun: null,
      });
      const source = values.find(
        (row) => row.productId === item.remoteProductId,
      )!;
      const copy = {
        en: `Synthetic maintained summary ${source.sku}`,
        "zh-Hant": `合成人工摘要 ${source.sku}`,
      };
      const content = {
        ...emptyWorkingListing(),
        sku: source.sku,
        priceHkd: 128.5,
        stockQuantity: 6,
        vintage: 2020,
        volumeMl: 750,
        packQuantity: 6,
        title: { en: source.nameEn, "zh-Hant": source.nameZh },
        description: copy,
        seo: { title: copy, description: copy },
      };
      if (index === 0) {
        await page.goto(`/listings/${item.listingId}`);
        for (const [label, value] of [
          ["Merchant SKU", source.sku],
          ["Selling price (HK$)", "128.5"],
          ["Stock", "6"],
          ["Vintage", "2020"],
          ["Volume (ml)", "750"],
          ["Pack quantity", "6"],
          ["English title", source.nameEn],
          ["Chinese title", source.nameZh],
          ["English description", copy.en],
          ["Chinese description", copy["zh-Hant"]],
          ["English SEO title", copy.en],
          ["Chinese SEO title", copy["zh-Hant"]],
          ["English SEO description", copy.en],
          ["Chinese SEO description", copy["zh-Hant"]],
        ])
          await page.getByLabel(label!, { exact: true }).fill(value!);
        await page
          .getByRole("button", { name: "Save draft", exact: true })
          .click();
        await expect(
          page.getByText("Input revision 2", { exact: false }),
        ).toBeVisible();
        const reviewed = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/api/listings/${item.listingId}/review` &&
            response.request().method() === "PUT",
        );
        await page
          .getByRole("button", {
            name: "Save as a review version",
            exact: true,
          })
          .click();
        expect((await reviewed).status()).toBe(200);
        await expect(
          page.getByText("Input revision 3", { exact: false }),
        ).toBeVisible();
      } else {
        const promoted = await page.request.put(
          `/api/listings/${item.listingId}/review`,
          {
            headers: { "Idempotency-Key": randomUUID() },
            data: { baseVersionId: null, expectedInputRevision: 1, content },
          },
        );
        expect(promoted.status()).toBe(200);
      }
      const saved = await (
        await page.request.get(`/api/listings/${item.listingId}`)
      ).json();
      expect(saved).toMatchObject({
        status: "in_review",
        activeVersion: {
          content: {
            sku: source.sku,
            priceHkd: 128.5,
            stockQuantity: 6,
            packQuantity: 6,
          },
        },
      });
      expect(saved.sourceReadiness.sourceImportId).toBe(receipt.sourceImportId);
    }
    const [sideEffects] =
      await admin`select (select count(*)::int from ai_runs where workspace_id=${fixture.workspaceId}) ai,(select count(*)::int from publish_jobs where workspace_id=${fixture.workspaceId}) publish,(select count(*)::int from source_imports where workspace_id=${fixture.workspaceId}) imports,(select count(*)::int from listing_versions where workspace_id=${fixture.workspaceId}) versions`;
    expect(sideEffects).toEqual({
      ai: 0,
      publish: 0,
      imports: 1,
      versions: 20,
    });
    expect(
      (
        await (
          await page.request.get(`/api/workbook-products/${reference.id}`)
        ).json()
      ).canExport,
    ).toBe(false);
    expect(errors).toEqual([]);
    await page.goto("/catalog?filter=review");
    await expect(
      page.getByRole("row").filter({ hasText: "synthetic-maintenance-" }),
    ).toHaveCount(20);
    await mkdir(resolve("node_modules/.opak-evidence"), { recursive: true });
    await page.screenshot({
      path: resolve("node_modules/.opak-evidence/maintenance-20-review.png"),
      fullPage: true,
    });
  } finally {
    await admin.end();
  }
});
