import {
  expect,
  test,
  type Page,
  type Locator,
  type TestInfo,
} from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDatabase } from "../../packages/db/src/client.js";
import { listingInputDigest } from "../../packages/db/src/repositories/listing-inputs.js";
import type {
  CatalogPage,
  PlatformCatalogItem,
} from "../../apps/web/lib/catalog-contract.js";
import type { CanonicalListing } from "../../packages/core/src/index.js";
import { BULK_FORM_COLUMNS } from "../../packages/shopline/src/bulk-form.js";
import { writeBulkFormWorkbook } from "../../packages/shopline/src/bulk-form-xlsx.js";
import { hashPassword } from "../../apps/web/lib/password-crypto.js";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "../../apps/web/lib/review-confirmation-keys.js";
import {
  ADMIN_URL,
  RUNTIME_URL,
  prepareBulkUpdateFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";

// The second serial case exports five of the twenty actual Queue-maintained products.
test.describe.configure({ mode: "serial" });
type Fixture = Awaited<ReturnType<typeof prepareBulkUpdateFixture>>;
type Product = Record<string, string> & { productId: string; sku: string };
type View = {
  activeVersion: { id: string; content: CanonicalListing } | null;
  workingInput: {
    revision: number;
    workingContent: CanonicalListing;
    fieldStates: Record<string, { owner: string; locked: boolean }>;
  };
  reviewConfirmation: { revision: number } | null;
  sourceImportId: string;
  contentDigest: string;
  reviewedSourceImportId: string;
  reviewedRowDigest: string;
};
type Approval = {
  listingId: string;
  expectedVersionId: string;
  confirmationLedgerRevision: number;
  expectedSourceImportId: string;
  expectedRowDigest: string;
};
let maintained: { fixture: Fixture; ids: string[] } | undefined;

// Independent merchant definition: later expected cells and supplied snapshot
// are constructed here, never from artifacts A/B or their parsed values.
const merchant: Product[] = Array.from({ length: 20 }, (_, index) => ({
  ...Object.fromEntries(BULK_FORM_COLUMNS.map((column) => [column.key, ""])),
  productId: "synthetic-f13-product-" + (index + 1),
  sku: String(674 + index).padStart(6, "0"),
  nameEn: "SYN Estate Riesling 2024 750ml 6 bottles " + (index + 1),
  nameZh: "原有合成商品 " + (index + 1),
  regularPrice: "00100.00",
  quantity: "06",
  updateQuantity: "+5",
  barcode: "0000000123" + String(index).padStart(2, "0"),
  onlineStoreCategories: "White Wine>Germany\r\nTop Picks",
  promotionLabelEn: " line 1\nline 2 & <tag> ",
  weightKg: "00.7500",
}));
const humanTitle = (product: Product) => "人工確認合成商品 " + product.sku;
const repairedTitle = (product: Product) => "人工修復合成商品 " + product.sku;
const headers = [
  BULK_FORM_COLUMNS.map((c) => c.en),
  BULK_FORM_COLUMNS.map((c) => c.zh),
];
const generatedFields = CONFIRMATION_FIELD_KEYS.filter(
  (key) => key !== "nameZh",
);
const mimeType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function merchantWorkbook(
  products: readonly Product[],
  titles?: ReadonlyMap<string, string>,
) {
  return Buffer.from(
    writeBulkFormWorkbook([
      ...headers.map((row) => [...row]),
      ...products.map((product) =>
        BULK_FORM_COLUMNS.map((c) =>
          c.key === "nameZh" && titles?.has(product.productId)
            ? titles.get(product.productId)!
            : (product[c.key] ?? ""),
        ),
      ),
    ]),
  );
}
function hkTime(seconds = false) {
  const value = new Date(Date.now() + 8 * 3600_000)
    .toISOString()
    .slice(0, seconds ? 19 : 16);
  // Chromium canonicalizes an exact zero second to the minute-only value.
  return seconds ? value.replace(/:00$/, "") : value;
}
function guard(info: TestInfo) {
  test.skip(
    process.env.WUKONG_OPAK_E2E !== "1" || process.env.PLAYWRIGHT_E2E !== "1",
    "Explicit isolated Opak real-stack acceptance required.",
  );
  const admin = new URL(ADMIN_URL),
    runtime = new URL(RUNTIME_URL);
  for (const target of [
    admin,
    runtime,
    new URL(String(info.project.use.baseURL)),
  ])
    expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
  expect(admin.port).toBe("54329");
  expect(runtime.host + runtime.pathname).toBe(admin.host + admin.pathname);
  expect(admin.pathname).toMatch(/^\/opak_fixes_[a-z0-9_]+$/);
  expect(runtime.username).toBe("wukong_app");
}
async function assertRuntimeRls(requireTables = true) {
  const app = postgres(RUNTIME_URL, { max: 1, prepare: false });
  try {
    const [role] =
      await app`select current_user name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(role).toEqual({
      name: "wukong_app",
      rolsuper: false,
      rolbypassrls: false,
    });
    if (!requireTables) return;
    const tables =
      await app`select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname in ('listing_drafts','listing_versions','export_attempts','import_results') order by relname`;
    expect(tables).toHaveLength(4);
    expect(tables.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(
      true,
    );
  } finally {
    await app.end();
  }
}
const postResponse = (page: Page, pathname: string, method = "POST") =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === pathname && r.request().method() === method,
  );
async function listing(page: Page, id: string): Promise<View> {
  const response = await page.request.get("/api/listings/" + id);
  expect(response.status()).toBe(200);
  return response.json();
}
function active(view: View) {
  expect(view.activeVersion).not.toBeNull();
  return view.activeVersion!;
}
async function confirm(page: Page, id: string): Promise<Approval> {
  const view = await listing(page, id),
    version = active(view);
  const response = await page.request.patch(
    "/api/listings/" + id + "/review-confirmations",
    {
      data: {
        versionId: version.id,
        expectedRevision: view.reviewConfirmation?.revision ?? null,
        fieldConfirmations: Object.fromEntries(
          CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
        ),
        negativeConfirmations: Object.fromEntries(
          CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
        ),
      },
    },
  );
  expect(response.status()).toBe(200);
  const ledger = await response.json();
  expect(view.reviewedSourceImportId).toBe(view.sourceImportId);
  expect(view.reviewedRowDigest).toBe(view.contentDigest);
  return {
    listingId: id,
    expectedVersionId: version.id,
    confirmationLedgerRevision: ledger.revision,
    expectedSourceImportId: view.sourceImportId,
    expectedRowDigest: view.contentDigest,
  };
}
// Independent stored ZIP/XML inspection, without production workbook readers.
function inspectWorkbook(bytes: Buffer): Array<Array<string | null>> {
  let offset = 0,
    xml = "";
  while (
    offset + 30 <= bytes.length &&
    bytes.readUInt32LE(offset) === 0x04034b50
  ) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    const size = bytes.readUInt32LE(offset + 18),
      n = bytes.readUInt16LE(offset + 26),
      extra = bytes.readUInt16LE(offset + 28),
      start = offset + 30 + n + extra;
    if (
      bytes.toString("utf8", offset + 30, offset + 30 + n) ===
      "xl/worksheets/sheet1.xml"
    ) {
      xml = bytes.toString("utf8", start, start + size);
      break;
    }
    offset = start + size;
  }
  expect(xml).not.toBe("");
  return [...xml.matchAll(/<row r="[0-9]+">([\s\S]*?)<\/row>/g)].map(
    (match) => {
      const cells = Array<string | null>(71).fill(null);
      for (const cell of match[1]!.matchAll(
        /<c r="([A-Z]+)[0-9]+" t="inlineStr"><is><t xml:space="preserve">([\s\S]*?)<\/t><\/is><\/c>/g,
      )) {
        const position =
          [...cell[1]!].reduce(
            (n, letter) => n * 26 + letter.charCodeAt(0) - 64,
            0,
          ) - 1;
        cells[position] = cell[2]!
          .replaceAll("&#13;", "\r")
          .replaceAll("&#10;", "\n")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&");
      }
      return cells;
    },
  );
}
function assertOnlyChineseName(
  bytes: Buffer,
  titles: ReadonlyMap<string, string>,
) {
  const rows = inspectWorkbook(bytes);
  expect(rows.slice(0, 2)).toEqual(headers);
  expect(rows).toHaveLength(titles.size + 2);
  expect(
    rows
      .slice(2)
      .map((row) => row[0])
      .sort(),
  ).toEqual([...titles.keys()].sort());
  for (const row of rows.slice(2)) {
    const original = merchant.find((p) => p.productId === row[0])!;
    expect(original).toBeDefined();
    for (let position = 0; position < 71; position++)
      expect(row[position], "Independent original cell " + position).toBe(
        position === 2
          ? titles.get(original.productId)
          : position === 39
            ? "+0"
            : original[BULK_FORM_COLUMNS[position]!.key] || null,
      );
  }
}
async function download(page: Page, id: string) {
  const response = await page.request.get(
    "/api/listings/export/" + id + "/download",
  );
  expect(response.status()).toBe(200);
  return response.body();
}
async function exportChineseName(
  page: Page,
  region: Locator,
  count: number,
  afterPreview?: () => Promise<void>,
) {
  const preview = region.getByRole("button", {
    name: "Preview Bulk Update XLSX",
    exact: true,
  });
  await expect(preview).toBeDisabled();
  await region
    .getByLabel("I confirm this SHOPLINE source export is still current.", {
      exact: true,
    })
    .check();
  await expect(preview).toBeDisabled();
  await region.getByLabel("Chinese name", { exact: true }).check();
  for (const label of [
    "English summary",
    "Chinese summary",
    "English SEO title",
    "Chinese SEO title",
    "English SEO description",
    "Chinese SEO description",
    "SEO keywords",
  ])
    await expect(region.getByLabel(label, { exact: true })).not.toBeChecked();
  const previewed = postResponse(page, "/api/listings/export/preview");
  await preview.click();
  const response = await previewed;
  expect(response.status()).toBe(200);
  const plan = await response.json();
  expect(plan).toMatchObject({ fields: ["nameZh"], rowCount: count });
  expect(plan.changes).toHaveLength(count);
  expect(
    plan.changes.every(
      (c: { column: string; versionId: string; sourceSnapshotId: string }) =>
        c.column === "nameZh" && c.versionId && c.sourceSnapshotId,
    ),
  ).toBe(true);
  await expect(
    region.getByRole("region", { name: "XLSX update preview", exact: true }),
  ).toBeVisible();
  await afterPreview?.();
  const exported = postResponse(page, "/api/listings/export");
  await region
    .getByRole("button", { name: "Generate Bulk Update XLSX", exact: true })
    .click();
  const artifact = await exported;
  expect(artifact.status()).toBe(200);
  expect(artifact.request().postDataJSON().previewSha256).toBe(
    plan.previewSha256,
  );
  expect(artifact.request().postDataJSON().fields).toEqual(["nameZh"]);
  const receipt = await artifact.json();
  expect(receipt).toMatchObject({ rowCount: count, artifactStatus: "ready" });
  expect(receipt.manifest).toHaveLength(count);
  expect(
    receipt.manifest.every(
      (m: { outcome: string }) => m.outcome === "included",
    ),
  ).toBe(true);
  return receipt;
}

test("20 merchant XLSX products preserve human facts and title through four real Queue waves, current review and partial approval", async ({
  page,
  browser,
}, info) => {
  guard(info);
  test.setTimeout(300_000);
  await assertRuntimeRls(false); // Check the actual non-bypass role before fixture writes.
  const fixture = await prepareBulkUpdateFixture();
  await assertRuntimeRls();
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false }),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await signInBulkImportOperator(page, fixture);
    const workbook = merchantWorkbook(merchant),
      upload = {
        name: "synthetic-f13-20-merchant-defined.xlsx",
        mimeType,
        buffer: workbook,
      };
    await page.locator("#workbook-import-file").setInputFiles(upload);
    const referenceImported = postResponse(page, "/api/workbook-imports");
    await page
      .getByRole("button", { name: "Import 20 products", exact: true })
      .click();
    expect((await referenceImported).status()).toBe(201);
    await page.getByRole("link", { name: "View catalog", exact: true }).click();
    const references = await (
      await page.request.get("/api/catalog?filter=workbook")
    ).json();
    expect(references.summary).toMatchObject({
      referenceRows: 20,
      drafts: 0,
      boundProducts: 0,
    });
    const reference = references.items.find(
      (item: { sourceProductId: string }) =>
        item.sourceProductId === merchant[0]!.productId,
    );
    expect(reference).toBeDefined();
    await page.goto(
      "/listings/import?intent=maintain-existing&referenceKind=workbook&referenceId=" +
        reference.id,
    );
    await page
      .getByRole("button", { name: "Use and check", exact: true })
      .click();
    await expect(page.locator("#maintenance-product-id")).toHaveValue(
      merchant[0]!.productId,
    );
    await page.locator("#bulk-import-file").setInputFiles(upload);
    await page.locator("#merchant-attested-export-at").fill(hkTime());
    await page.getByLabel(/I checked the actual product/).check();
    await page.locator("#bulk-source-confirmation").check();
    const imported = postResponse(page, "/api/listings/import");
    await page
      .getByRole("button", { name: "Start import", exact: true })
      .click();
    const importResponse = await imported;
    expect(importResponse.status()).toBe(201);
    const intake = await importResponse.json();
    expect(intake).toMatchObject({
      createdDrafts: 20,
      replayed: false,
      invalidatedApprovals: 0,
    });
    const [received] =
      await admin`select workbook_sha256 from source_imports where workspace_id=${fixture.workspaceId} and id=${intake.sourceImportId}`;
    expect(received!.workbook_sha256).toBe(
      createHash("sha256").update(workbook).digest("hex"),
    );
    const catalog = await (
      await page.request.get("/api/catalog?filter=bound&pageSize=100")
    ).json();
    expect(catalog.items).toHaveLength(20);
    const ids: string[] = merchant.map((product) => {
      const row = catalog.items.find(
        (item: { remoteProductId: string }) =>
          item.remoteProductId === product.productId,
      );
      expect(row).toBeDefined();
      return row.listingId;
    });
    const originals = new Map<string, CanonicalListing>();
    // Repetitive human fact saves use authenticated routes. Generated versions and AI outputs are never seeded.
    for (const [index, id] of ids.entries()) {
      const product = merchant[index]!,
        view = await listing(page, id);
      expect(view.activeVersion).toBeNull();
      expect(view.workingInput.revision).toBe(1);
      const saved = await page.request.patch(
        "/api/listings/" + id + "/inputs",
        {
          headers: { "Idempotency-Key": randomUUID() },
          data: {
            expectedInputRevision: 1,
            baseVersionId: null,
            action: "save",
            changes: [
              { field: "producer", value: "SYN Estate", locked: true },
              { field: "productType", value: "wine", locked: true },
              { field: "country", value: "Germany", locked: true },
              { field: "region", value: "Mosel", locked: true },
              { field: "vintage", value: 2024, locked: true },
              { field: "grapeVarieties", value: ["Riesling"], locked: true },
              { field: "volumeMl", value: 750, locked: true },
              { field: "abvPercent", value: 12.5, locked: true },
              { field: "packQuantity", value: 6, locked: true },
              {
                field: "title.zh-Hant",
                value: humanTitle(product),
                locked: true,
              },
            ],
          },
        },
      );
      expect(saved.status()).toBe(200);
      const current = await listing(page, id);
      expect(current.workingInput.fieldStates["title.zh-Hant"]).toMatchObject({
        owner: "operator",
        locked: true,
      });
      expect(current.workingInput.workingContent).toMatchObject({
        sku: product.sku,
        priceHkd: 100,
        stockQuantity: 6,
        packQuantity: 6,
      });
      originals.set(id, structuredClone(current.workingInput.workingContent));
    }
    await page.goto("/catalog?filter=bound");
    for (const product of merchant)
      await page
        .getByLabel("Select " + product.sku + " for Bulk Update", {
          exact: true,
        })
        .check();
    await expect(
      page.getByText("20 selected for Bulk Update", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Label", { exact: true })
      .fill("Synthetic F13 twenty maintained products");
    await page.getByLabel("Budget (USD)", { exact: true }).fill("1");
    await page.getByLabel("Wave size (1-5)", { exact: true }).fill("5");
    await page.getByRole("checkbox", { name: "nameZh", exact: true }).uncheck();
    for (const field of generatedFields)
      await page.getByRole("checkbox", { name: field, exact: true }).check();
    await expect(
      page.getByRole("checkbox", { name: "nameZh", exact: true }),
    ).not.toBeChecked();
    const previewed = postResponse(page, "/api/enrichment-batches/preview");
    await page
      .getByRole("button", { name: "Preview batch", exact: true })
      .click();
    expect((await previewed).status()).toBe(200);
    await expect(
      page.getByRole("region", { name: "Batch preview", exact: true }),
    ).toContainText("eligible 20");
    const [noCalls] =
      await admin`select (select count(*)::int from ai_runs where workspace_id=${fixture.workspaceId}) calls,(select count(*)::int from listing_pipeline_runs where workspace_id=${fixture.workspaceId}) runs`;
    expect(noCalls).toEqual({ calls: 0, runs: 0 });
    const created = postResponse(page, "/api/enrichment-batches");
    await page
      .getByRole("button", { name: "Confirm create batch", exact: true })
      .click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    const batch = await createdResponse.json();
    expect(batch.selected).toBe(20);
    for (let wave = 0; wave < 4; wave++) {
      await page.goto("/batches/" + batch.batchId);
      const advanced = postResponse(
        page,
        "/api/enrichment-batches/" + batch.batchId + "/advance",
      );
      await page.getByRole("button", { name: /Advance/ }).click();
      const accepted = await advanced;
      expect(accepted.status()).toBe(202);
      expect((await accepted.json()).enqueued).toBe(5);
      await expect
        .poll(
          async () =>
            (
              await admin`select count(*)::int count from listing_drafts where workspace_id=${fixture.workspaceId} and status='in_review' and active_version_id is not null`
            )[0]!.count,
          {
            timeout: 60_000,
            message:
              "Real fake-provider Queue wave adopts five current versions",
          },
        )
        .toBe((wave + 1) * 5);
    }
    await page.goto("/batches/" + batch.batchId);
    const reconciled = postResponse(
      page,
      "/api/enrichment-batches/" + batch.batchId + "/advance",
    );
    await page.getByRole("button", { name: /Advance/ }).click();
    const completed = await reconciled;
    expect(completed.status()).toBe(202);
    expect(await completed.json()).toMatchObject({
      status: "completed",
      enqueued: 0,
    });
    const [observed] =
      await admin`select count(*) filter(where task='generate' and model='fake-listing-provider')::int generated,count(*) filter(where task='extract' and model='maintenance-snapshot')::int snapshot_observations,count(*) filter(where task='extract' and model<>'maintenance-snapshot')::int provider_extractions,count(*) filter(where task not in ('generate','extract'))::int other_calls,count(*) filter(where provider <> 'fake')::int non_fake_calls,count(*) filter(where estimated_cost_usd is null or estimated_cost_usd <> 0)::int unknown_or_paid_calls,coalesce(sum(estimated_cost_usd),0)::text usd from ai_runs where workspace_id=${fixture.workspaceId}`;
    expect(observed).toMatchObject({
      generated: 20,
      snapshot_observations: 20,
      provider_extractions: 0,
      other_calls: 0,
      non_fake_calls: 0,
      unknown_or_paid_calls: 0,
    });
    expect(Number(observed!.usd)).toBe(0);
    const [adopted] =
      await admin`select count(*)::int runs,count(*) filter(where execution_state='succeeded')::int succeeded,count(*) filter(where execution->'contentFields' @> '["nameZh"]'::jsonb)::int title_requests from listing_pipeline_runs where workspace_id=${fixture.workspaceId}`;
    expect(adopted).toEqual({ runs: 20, succeeded: 20, title_requests: 0 });
    const [submissions] =
      await admin`select count(*)::int count from audit_events where workspace_id=${fixture.workspaceId} and action='listing.submitted_for_review'`;
    expect(submissions!.count).toBe(20);
    const approved = new Map<string, Approval>();
    for (const [index, id] of ids.entries()) {
      const view = await listing(page, id),
        content = active(view).content,
        original = originals.get(id)!;
      expect(content).toMatchObject({
        sku: merchant[index]!.sku,
        producer: "SYN Estate",
        productType: "wine",
        country: "Germany",
        region: "Mosel",
        vintage: 2024,
        grapeVarieties: ["Riesling"],
        volumeMl: 750,
        abvPercent: 12.5,
        packQuantity: 6,
        priceHkd: 100,
        stockQuantity: 6,
      });
      expect(content.title).toEqual(original.title);
      const {
        title: _title,
        description: _description,
        seo: _seo,
        tags: _tags,
        ...facts
      } = content;
      const {
        title: _oldTitle,
        description: _oldDescription,
        seo: _oldSeo,
        tags: _oldTags,
        ...originalFacts
      } = original;
      expect(facts).toEqual(originalFacts);
      for (const value of [
        content.description.en,
        content.description["zh-Hant"],
        content.seo.title.en,
        content.seo.title["zh-Hant"],
        content.seo.description.en,
        content.seo.description["zh-Hant"],
      ])
        expect(value).not.toBe("");
      expect(content.tags.length).toBeGreaterThan(0);
      expect(view.workingInput.fieldStates["title.zh-Hant"]).toMatchObject({
        owner: "operator",
        locked: true,
      });
      approved.set(id, await confirm(page, id));
    }
    const staleId = ids[19]!,
      staleObservation = approved.get(staleId)!,
      renewed = await confirm(page, staleId);
    expect(renewed.confirmationLedgerRevision).toBeGreaterThan(
      staleObservation.confirmationLedgerRevision,
    );
    const partial = await page.request.post("/api/listings/bulk-approve", {
      data: { items: [...approved.values()] },
    });
    expect(partial.status()).toBe(200);
    const partialReceipt = await partial.json();
    expect(partialReceipt).toMatchObject({ approved: 19, failed: 1 });
    expect(
      partialReceipt.results.filter((r: { ok: boolean }) => !r.ok),
    ).toEqual([
      expect.objectContaining({
        listingId: staleId,
        ok: false,
        code: "confirmation_ledger_stale",
      }),
    ]);
    const [firstAudits] =
      await admin`select count(*) filter(where action='listing.approved')::int approvals,count(*) filter(where action='listing.bulk_update_approval_bound')::int bindings,count(*) filter(where entity_id=${staleId} and action='listing.approved')::int stale_approvals from audit_events where workspace_id=${fixture.workspaceId}`;
    expect(firstAudits).toEqual({
      approvals: 19,
      bindings: 19,
      stale_approvals: 0,
    });
    const remaining = await page.request.post("/api/listings/bulk-approve", {
      data: { items: [renewed] },
    });
    expect(remaining.status()).toBe(200);
    expect(await remaining.json()).toMatchObject({ approved: 1, failed: 0 });
    const [allAudits] =
      await admin`select count(*) filter(where action='listing.approved')::int approvals,count(*) filter(where action='listing.bulk_update_approval_bound')::int bindings from audit_events where workspace_id=${fixture.workspaceId}`;
    expect(allAudits).toEqual({ approvals: 20, bindings: 20 });
    // Distinct real credential login; no authentication-cookie fabrication.
    const operator = {
      ...fixture,
      userId: "f13_operator_" + randomUUID(),
      email: "f13-operator-" + randomUUID() + "@local.invalid",
      password: "Synthetic F13 operator password 1!",
    };
    const passwordHash = await hashPassword(operator.password);
    await admin`insert into users(id,email,auth_email_verified) values(${operator.userId},${operator.email},true)`;
    await admin`insert into memberships(workspace_id,user_id,role) values(${fixture.workspaceId},${operator.userId},'operator')`;
    await admin`insert into workspace_invites(workspace_id,email,role,status) values(${fixture.workspaceId},${operator.email},'operator','accepted')`;
    await admin`insert into auth_accounts(id,user_id,account_id,provider_id,password) values(${randomUUID()},${operator.userId},${operator.userId},'credential',${passwordHash})`;
    const context = await browser.newContext({
      baseURL: String(info.project.use.baseURL),
    });
    try {
      const operatorPage = await context.newPage();
      await signInBulkImportOperator(operatorPage, operator, false);
      const mask = {
        listingIds: [ids[0]],
        fields: ["nameZh"],
        attestation: {
          listings: [
            {
              listingId: ids[0],
              contentDigest: (await listing(operatorPage, ids[0]!))
                .contentDigest,
            },
          ],
        },
      };
      for (const [url, data] of [
        ["/api/listings/" + ids[0] + "/approve", approved.get(ids[0]!)],
        ["/api/listings/bulk-approve", { items: [approved.get(ids[0]!)] }],
        ["/api/listings/export/preview", mask],
        ["/api/listings/export", { ...mask, previewSha256: "a".repeat(64) }],
      ] as const) {
        const denied = await operatorPage.request.post(url, { data });
        expect(denied.status(), "Operator actual denial " + url).toBe(403);
        expect(await denied.json()).toMatchObject({
          code: "insufficient_role",
        });
      }
      // Complete account/admin/member/policy journeys remain in the D suite.
      expect(
        (await operatorPage.request.get("/api/workspace/members")).status(),
      ).toBe(403);
      expect(
        (await operatorPage.request.get("/api/workspace/policies")).status(),
      ).toBe(403);
    } finally {
      await context.close();
    }
    expect(errors).toEqual([]);
    maintained = { fixture, ids };
    await info.attach("synthetic-maintenance-observations", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          synthetic: true,
          products: 20,
          waves: [5, 5, 5, 5],
          currentAdoptions: 20,
          fakeGenerateCalls: 20,
          maintenanceSnapshotObservations: 20,
          providerExtractCalls: 0,
          usd: 0,
          initialApprovals: 19,
          staleRejected: 1,
          renewedApprovals: 1,
          repetitiveFactsAndConfirmations: "authenticated actual APIs",
          keyJourneyActions: "UI",
          productionOrMerchantOriginVerified: false,
        }),
      ),
    });
  } finally {
    await admin.end();
  }
});

test("five-row name-only export keeps A immutable, repairs only two rejected products in B and compares an independent supplied snapshot", async ({
  page,
}, info) => {
  guard(info);
  test.setTimeout(180_000);
  expect(
    maintained,
    "Actual twenty-product maintenance prerequisite must finish",
  ).toBeDefined();
  const { fixture, ids } = maintained!,
    selectedIds = ids.slice(0, 5),
    products = merchant.slice(0, 5);
  const acceptedIds = selectedIds.slice(0, 3),
    rejectedIds = selectedIds.slice(3),
    admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await signInBulkImportOperator(page, fixture, false);
    await page.goto("/catalog?filter=bound");
    for (const product of products)
      await page
        .getByLabel("Select " + product.sku + " for Bulk Update", {
          exact: true,
        })
        .check();
    const region = page.getByRole("region", {
      name: "Bulk Update XLSX export",
      exact: true,
    });
    const [before] =
      await admin`select count(*)::int count from export_attempts where workspace_id=${fixture.workspaceId}`;
    expect(before!.count).toBe(0);
    const a = await exportChineseName(page, region, 5, async () => {
        const [pure] =
          await admin`select count(*)::int count from export_attempts where workspace_id=${fixture.workspaceId}`;
        expect(pure!.count).toBe(0);
      }),
      titlesA = new Map(products.map((p) => [p.productId, humanTitle(p)]));
    const bytesA = await download(page, a.exportAttemptId);
    assertOnlyChineseName(bytesA, titlesA);
    expect(createHash("sha256").update(bytesA).digest("hex")).toBe(
      a.artifactSha256,
    );
    await page.goto("/jobs");
    const cardA = page.locator(
      '[data-export-attempt-id="' + a.exportAttemptId + '"]',
    );
    await expect(cardA).toBeVisible();
    // First report uses UI; repetition uses the same authenticated real route
    // with observed immutable A version IDs, not current-version guesses.
    const first = cardA.locator('[data-listing-id="' + acceptedIds[0] + '"]');
    await first
      .getByRole("combobox", { name: "Outcome", exact: true })
      .selectOption("accepted");
    const recorded = postResponse(
      page,
      "/api/listings/" + acceptedIds[0] + "/shopline-import-result",
    );
    await first
      .getByRole("button", { name: "Record operator result", exact: true })
      .click();
    expect((await recorded).status()).toBe(201);
    for (const [index, id] of selectedIds.entries()) {
      if (index === 0) continue;
      const version = a.manifest.find(
          (m: { listingId: string }) => m.listingId === id,
        ).versionId,
        outcome = index < 3 ? "accepted" : "rejected";
      const result = await page.request.post(
        "/api/listings/" + id + "/shopline-import-result",
        {
          data: {
            mode: "export",
            exportAttemptId: a.exportAttemptId,
            versionId: version,
            outcome,
            ...(outcome === "rejected"
              ? {
                  rejectReason:
                    "Synthetic rejected Chinese name " + merchant[index]!.sku,
                }
              : {}),
            idempotencyKey: randomUUID(),
          },
        },
      );
      expect(result.status()).toBe(201);
    }
    const detailA = await (
      await page.request.get("/api/listings/export/" + a.exportAttemptId)
    ).json();
    expect(detailA.reconciliation.counts).toEqual({
      requested: 5,
      included: 5,
      excluded: 0,
      noOp: 0,
      accepted: 3,
      rejected: 2,
      unreported: 0,
    });
    expect(detailA.reconciliation.verificationStatus).toBe("unverified");
    expect(
      detailA.reconciliation.members.every(
        (m: { history: unknown[] }) => m.history.length === 1,
      ),
    ).toBe(true);
    const immutableA = JSON.stringify(detailA.attempt),
      immutableReports = JSON.stringify(detailA.reconciliation.members),
      acceptedVersions = new Map<string, string>();
    for (const id of acceptedIds)
      acceptedVersions.set(id, active(await listing(page, id)).id);
    const titlesB = new Map<string, string>();
    // Only rejected listings receive repaired human review versions.
    for (const id of rejectedIds) {
      const product = merchant[ids.indexOf(id)]!,
        old = await listing(page, id);
      const content = {
        ...active(old).content,
        title: {
          ...active(old).content.title,
          "zh-Hant": repairedTitle(product),
        },
      };
      await page.goto("/listings/" + id);
      await page
        .getByRole("textbox", {
          name: "Title (Traditional Chinese)",
          exact: true,
        })
        .fill(repairedTitle(product));
      const saved = postResponse(
        page,
        "/api/listings/" + id + "/review",
        "PUT",
      );
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      expect((await saved).status()).toBe(200);
      const current = await listing(page, id);
      expect(active(current).id).not.toBe(active(old).id);
      expect(active(current).content).toEqual(content);
      const approval = await confirm(page, id),
        approved = await page.request.post("/api/listings/bulk-approve", {
          data: { items: [approval] },
        });
      expect(approved.status()).toBe(200);
      expect(await approved.json()).toMatchObject({ approved: 1, failed: 0 });
      titlesB.set(product.productId, repairedTitle(product));
    }
    for (const id of acceptedIds)
      expect(active(await listing(page, id)).id).toBe(acceptedVersions.get(id));
    await page.goto("/jobs");
    await expect(cardA).toBeVisible();
    const repair = cardA.getByRole("region", {
      name: "Repair rejected items",
      exact: true,
    });
    const observed = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          "/api/listings/export/" + a.exportAttemptId &&
        r.request().method() === "GET",
    );
    await repair
      .getByRole("button", {
        name: "Preview rejected-only repair XLSX",
        exact: true,
      })
      .click();
    const sourceResponse = await observed;
    expect(sourceResponse.status()).toBe(200);
    const sources = await sourceResponse.json();
    expect(
      sources.repairSourceObservations
        .map((r: { listingId: string }) => r.listingId)
        .sort(),
    ).toEqual([...rejectedIds].sort());
    await expect(
      repair.getByText(/Current source import/).first(),
    ).toBeVisible();
    const b = await exportChineseName(
      page,
      repair.getByRole("region", {
        name: "Bulk Update XLSX export",
        exact: true,
      }),
      2,
      async () => {
        const [pure] =
          await admin`select count(*)::int count from export_attempts where workspace_id=${fixture.workspaceId}`;
        expect(pure!.count).toBe(1);
      },
    );
    expect(b.exportAttemptId).not.toBe(a.exportAttemptId);
    expect(
      b.manifest.map((m: { listingId: string }) => m.listingId).sort(),
    ).toEqual([...rejectedIds].sort());
    const bytesB = await download(page, b.exportAttemptId);
    assertOnlyChineseName(bytesB, titlesB);
    const detailB = await (
      await page.request.get("/api/listings/export/" + b.exportAttemptId)
    ).json();
    expect(detailB.reconciliation.repairOf).toEqual({
      exportAttemptId: a.exportAttemptId,
      members: detailA.reconciliation.members
        .filter((m: { listingId: string }) => rejectedIds.includes(m.listingId))
        .map(
          (m: {
            listingId: string;
            latestResult: { id: string; revision: number };
          }) => ({
            listingId: m.listingId,
            resultId: m.latestResult.id,
            revision: m.latestResult.revision,
          }),
        )
        .sort((l: { listingId: string }, r: { listingId: string }) =>
          l.listingId.localeCompare(r.listingId),
        ),
    });
    const aAfter = await (
      await page.request.get("/api/listings/export/" + a.exportAttemptId)
    ).json();
    expect(JSON.stringify(aAfter.attempt)).toBe(immutableA);
    expect(JSON.stringify(aAfter.reconciliation.members)).toBe(
      immutableReports,
    );
    expect(await download(page, a.exportAttemptId)).toEqual(bytesA);
    const attempts =
      await admin`select id from export_attempts where workspace_id=${fixture.workspaceId}`;
    expect(attempts).toHaveLength(2);
    // Reconstruct original merchant cells plus explicitly defined expected
    // accepted/repaired titles. A/B bytes never feed supplied input.
    const supplied = merchantWorkbook(
      products,
      new Map([...titlesA, ...titlesB]),
    );
    expect(createHash("sha256").update(supplied).digest("hex")).not.toBe(
      b.artifactSha256,
    );
    await page.goto("/jobs");
    const cardB = page.locator(
      '[data-export-attempt-id="' + b.exportAttemptId + '"]',
    );
    const comparison = cardB.getByRole("region", {
      name: "Fresh export comparison",
      exact: true,
    });
    await comparison
      .getByRole("button", { name: "Compare fresh export", exact: true })
      .click();
    await expect(comparison).toContainText("authenticated merchant origin");
    await expect(comparison).toContainText("current live SHOPLINE truth");
    await comparison
      .getByLabel("Fresh SHOPLINE XLSX", { exact: true })
      .setInputFiles({
        name: "independent-synthetic-merchant-defined-five.xlsx",
        mimeType,
        buffer: supplied,
      });
    await expect
      .poll(() => Date.now() - Date.parse(detailB.attempt.artifactReadyAt))
      .toBeGreaterThan(1000);
    await comparison
      .getByLabel("SHOPLINE export time (Hong Kong UTC+08:00)", { exact: true })
      .fill(hkTime(true));
    await comparison
      .getByLabel("I confirm this snapshot is from the same SHOPLINE store.", {
        exact: true,
      })
      .check();
    const verified = postResponse(
      page,
      "/api/listings/export/" + b.exportAttemptId + "/verifications",
    );
    await comparison
      .getByRole("button", { name: "Record snapshot comparison", exact: true })
      .click();
    const verification = await verified;
    expect(verification.status()).toBe(201);
    const proof = await verification.json();
    expect(proof.verification.comparison).toMatchObject({
      outcome: "matches_compared_fields",
      counts: { expected: 2, matched: 2, unrelatedRows: 3, suppliedRows: 5 },
    });
    expect(proof.verification.suppliedSha256).toBe(
      createHash("sha256").update(supplied).digest("hex"),
    );
    expect(proof.verification.suppliedSha256).not.toBe(b.artifactSha256);
    const unverified = await (
      await page.request.get("/api/listings/export/" + b.exportAttemptId)
    ).json();
    expect(unverified.reconciliation.verificationStatus).toBe("unverified");
    await info.attach("synthetic-export-lineage-observations", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          synthetic: true,
          requestedMask: ["nameZh"],
          independentCellPositionsPerRow: 71,
          artifactARows: 5,
          reportedAccepted: 3,
          reportedRejected: 2,
          artifactBRows: 2,
          acceptedRowsResent: 0,
          immutableA: true,
          suppliedRows: 5,
          comparedMatches: 2,
          unrelatedSuppliedRows: 3,
          suppliedInput:
            "merchant definition plus explicit expected titles; never artifact bytes",
          authenticatedMerchantOriginVerified: false,
          liveShoplineVerified: false,
        }),
      ),
    });
  } finally {
    await admin.end();
  }
});

// Independent fixture: this case never reads the twenty-product serial result.
test("100 independently imported products keep all cross-page UI selections in a name-only current-fenced preview without admission", async ({
  page,
}, info) => {
  guard(info);
  test.setTimeout(180_000);
  await assertRuntimeRls(false);
  const fixture = await prepareBulkUpdateFixture();
  await assertRuntimeRls();
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  const db = createDatabase(RUNTIME_URL, { migrationUrl: ADMIN_URL });
  const errors: string[] = [];
  const admissionRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      (path === "/api/enrichment-batches" ||
        /^\/api\/enrichment-batches\/[^/]+\/advance$/.test(path) ||
        /^\/api\/listings\/[^/]+\/enrich$/.test(path))
    )
      admissionRequests.push(path);
  });
  const products: Product[] = Array.from({ length: 100 }, (_, index) => ({
    ...merchant[index % merchant.length]!,
    productId: "synthetic-f13-uc22-product-" + (index + 1),
    sku: String(100000 + index),
    nameEn: "SYN UC22 Riesling 2024 750ml 6 bottles " + (index + 1),
    nameZh: "",
  }));
  async function admissionCounts() {
    const [counts] = await admin`select
      (select count(*)::int from ai_runs where workspace_id=${fixture.workspaceId}) ai_calls,
      (select coalesce(sum(estimated_cost_usd),0)::text from ai_runs where workspace_id=${fixture.workspaceId}) usd,
      (select count(*)::int from listing_pipeline_runs where workspace_id=${fixture.workspaceId}) pipeline_runs,
      (select count(*)::int from enrichment_batches where workspace_id=${fixture.workspaceId}) batches,
      (select count(*)::int from enrichment_batch_items where workspace_id=${fixture.workspaceId}) batch_items,
      (select count(*)::int from enrichment_batch_create_receipts where workspace_id=${fixture.workspaceId}) create_receipts,
      (select count(*)::int from listing_dispatch_outbox where workspace_id=${fixture.workspaceId}) dispatches,
      (select count(*)::int from ai_budget_reservations where workspace_id=${fixture.workspaceId}) reservations,
      (select count(*)::int from listing_versions where workspace_id=${fixture.workspaceId}) versions,
      (select count(*)::int from publish_jobs where workspace_id=${fixture.workspaceId}) publish_jobs`;
    expect(counts).toMatchObject({
      ai_calls: 0,
      pipeline_runs: 0,
      batches: 0,
      batch_items: 0,
      create_receipts: 0,
      dispatches: 0,
      reservations: 0,
      versions: 0,
      publish_jobs: 0,
    });
    expect(Number(counts!.usd)).toBe(0);
    return counts;
  }
  try {
    await signInBulkImportOperator(page, fixture);
    const workbook = merchantWorkbook(products);
    const upload = {
      name: "synthetic-f13-100-merchant-defined.xlsx",
      mimeType,
      buffer: workbook,
    };
    await page.locator("#workbook-import-file").setInputFiles(upload);
    const referenceImported = postResponse(page, "/api/workbook-imports");
    await page
      .getByRole("button", { name: "Import 100 products", exact: true })
      .click();
    expect((await referenceImported).status()).toBe(201);
    await page.getByRole("link", { name: "View catalog", exact: true }).click();
    const referencesResponse = await page.request.get(
      "/api/catalog?filter=workbook&pageSize=100",
    );
    expect(referencesResponse.status()).toBe(200);
    const references: CatalogPage = await referencesResponse.json();
    expect(references.items).toHaveLength(100);
    expect(references.summary).toMatchObject({
      referenceRows: 100,
      drafts: 0,
      boundProducts: 0,
    });
    const reference = references.items.find(
      (item) =>
        item.sourceType === "workbook" &&
        item.sourceProductId === products[0]!.productId,
    );
    expect(reference).toBeDefined();
    await page.goto(
      "/listings/import?intent=maintain-existing&referenceKind=workbook&referenceId=" +
        reference!.id,
    );
    await page
      .getByRole("button", { name: "Use and check", exact: true })
      .click();
    await expect(page.locator("#maintenance-product-id")).toHaveValue(
      products[0]!.productId,
    );
    await page.locator("#bulk-import-file").setInputFiles(upload);
    await page.locator("#merchant-attested-export-at").fill(hkTime());
    await page.getByLabel(/I checked the actual product/).check();
    await page.locator("#bulk-source-confirmation").check();
    const imported = postResponse(page, "/api/listings/import");
    await page
      .getByRole("button", { name: "Start import", exact: true })
      .click();
    const importResponse = await imported;
    expect(importResponse.status()).toBe(201);
    const intake = await importResponse.json();
    expect(intake).toMatchObject({
      createdDrafts: 100,
      replayed: false,
      invalidatedApprovals: 0,
    });
    const [received] =
      await admin`select workbook_sha256 from source_imports where workspace_id=${fixture.workspaceId} and id=${intake.sourceImportId}`;
    expect(received!.workbook_sha256).toBe(
      createHash("sha256").update(workbook).digest("hex"),
    );

    const catalogResponse = await page.request.get(
      "/api/catalog?filter=bound&pageSize=100",
    );
    expect(catalogResponse.status()).toBe(200);
    const catalog: CatalogPage = await catalogResponse.json();
    expect(catalog.items).toHaveLength(100);
    const bound = catalog.items.filter(
      (item): item is PlatformCatalogItem => item.sourceType === "platform",
    );
    expect(bound).toHaveLength(100);
    const ids = products.map((product) => {
      const row = bound.find(
        (item) => item.remoteProductId === product.productId,
      );
      expect(row).toBeDefined();
      expect(row!.sku).toBe(product.sku);
      expect(row!.listingId).not.toBeNull();
      expect(row!.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      return row!.listingId!;
    });
    expect(new Set(ids).size).toBe(100);
    // Repetitive pack confirmation uses actual authenticated CAS saves, not seeded inputs.
    for (const id of ids) {
      const saved = await page.request.patch(
        "/api/listings/" + id + "/inputs",
        {
          headers: { "Idempotency-Key": randomUUID() },
          data: {
            expectedInputRevision: 1,
            baseVersionId: null,
            action: "save",
            changes: [{ field: "packQuantity", value: 6, locked: true }],
          },
        },
      );
      expect(saved.status()).toBe(200);
    }
    const current = await db.forWorkspace(fixture.workspaceId, (repos) =>
      repos.platformProducts.getMaintenanceByIds(ids),
    );
    expect(current).toHaveLength(100);
    for (const row of current) {
      expect(row).toMatchObject({
        status: "needs_info",
        assessmentState: "assessed",
        fence: {
          inputRevision: 2,
          activeVersionId: null,
          sourceBinding: { sourceImportId: intake.sourceImportId },
        },
        content: { packQuantity: 6, title: { "zh-Hant": "" } },
      });
      const observed = bound.find((item) => item.listingId === row.listingId)!;
      expect(row.fence.sourceBinding).toMatchObject({
        productId: observed.id,
        rowDigest: observed.contentDigest,
      });
    }

    const selected: string[] = [];
    const digests = new Map<string, string>();
    const scope = listingInputDigest({
      workspaceId: fixture.workspaceId,
      actorId: fixture.userId,
      role: "reviewer",
    });
    for (let pageNumber = 1; pageNumber <= 4; pageNumber++) {
      const loaded = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/catalog" &&
          response.request().method() === "GET" &&
          url.searchParams.get("filter") === "bound" &&
          url.searchParams.get("page") === String(pageNumber) &&
          url.searchParams.get("pageSize") === "25"
        );
      });
      if (pageNumber === 1) await page.goto("/catalog?filter=bound");
      else {
        await expect(
          page.getByRole("button", { name: "Next", exact: true }),
        ).toBeEnabled();
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(page).toHaveURL(
          new RegExp("[?&]page=" + pageNumber + "(?:&|$)"),
        );
      }
      const loadedResponse = await loaded;
      expect(loadedResponse.status()).toBe(200);
      const displayed: CatalogPage = await loadedResponse.json();
      expect(displayed).toMatchObject({
        page: pageNumber,
        pageSize: 25,
        totalMatching: 100,
        selectionScope: scope,
      });
      expect(displayed.items).toHaveLength(25);
      await expect(
        page.getByRole("checkbox", { name: /for Bulk Update/ }),
      ).toHaveCount(25);
      for (const item of displayed.items) {
        expect(item.sourceType).toBe("platform");
        if (item.sourceType !== "platform")
          throw new Error("Bound catalog returned a non-platform row");
        expect(item.listingId).not.toBeNull();
        const id = item.listingId!;
        expect(ids).toContain(id);
        expect(selected).not.toContain(id);
        expect(item.contentDigest).toBe(
          bound.find((row) => row.listingId === id)!.contentDigest,
        );
        await page
          .getByLabel("Select " + item.sku + " for Bulk Update", {
            exact: true,
          })
          .check();
        selected.push(id);
        digests.set(id, item.contentDigest!);
      }
      await expect(
        page.getByText(pageNumber * 25 + " selected for Bulk Update", {
          exact: true,
        }),
      ).toBeVisible();
    }
    expect([...selected].sort()).toEqual([...ids].sort());
    expect(new Set(selected).size).toBe(100);
    await expect(
      page.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("75 selected products are outside this filter", {
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          (selectionScope) =>
            sessionStorage.getItem(
              "wukong:catalog:selection:" + selectionScope,
            ),
          scope,
        ),
      )
      .toBe(
        JSON.stringify({
          ids: selected,
          exports: [...digests],
        }),
      );

    await page
      .getByLabel("Label", { exact: true })
      .fill("Synthetic UC22 one hundred selected products");
    await page.getByLabel("Budget (USD)", { exact: true }).fill("1");
    await page.getByLabel("Wave size (1-5)", { exact: true }).fill("5");
    await page.getByRole("checkbox", { name: "nameZh", exact: true }).check();
    for (const field of generatedFields)
      await expect(
        page.getByRole("checkbox", { name: field, exact: true }),
      ).not.toBeChecked();
    const before = await admissionCounts();
    const [noPreview] =
      await admin`select count(*)::int count from enrichment_batch_previews where workspace_id=${fixture.workspaceId}`;
    expect(noPreview!.count).toBe(0);
    const previewed = postResponse(page, "/api/enrichment-batches/preview");
    await page
      .getByRole("button", { name: "Preview batch", exact: true })
      .click();
    const previewResponse = await previewed;
    expect(previewResponse.status()).toBe(200);
    const request = previewResponse.request().postDataJSON();
    expect(request.selection).toMatchObject({
      mode: "explicit",
      fields: ["nameZh"],
    });
    expect([...request.selection.listingIds].sort()).toEqual([...ids].sort());
    expect(new Set(request.selection.listingIds).size).toBe(100);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      selectedCount: 100,
      eligibleCount: 100,
      fields: ["nameZh"],
      budgetUsd: 1,
      waveSize: 5,
      maxCostUsd: 0,
      skippedByReason: {},
    });
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      page.getByRole("region", { name: "Batch preview", exact: true }),
    ).toContainText("Selected 100; eligible 100; 5 per wave.");
    await expect(
      page.getByRole("button", { name: "Confirm create batch", exact: true }),
    ).toBeEnabled();
    const previews =
      await admin`select id,workspace_id,actor_id,digest,expires_at,options from enrichment_batch_previews where workspace_id=${fixture.workspaceId}`;
    expect(previews).toHaveLength(1);
    const stored = previews[0]!;
    expect(stored).toMatchObject({
      id: preview.previewId,
      workspace_id: fixture.workspaceId,
      actor_id: fixture.userId,
      digest: preview.digest,
    });
    expect(new Date(stored.expires_at).toISOString()).toBe(preview.expiresAt);
    expect(stored.options.selection).toEqual({
      mode: "explicit",
      listingIds: [...ids].sort(),
      fields: ["nameZh"],
    });
    expect(stored.options.eligibleIds).toEqual([...ids].sort());
    expect(stored.options.fences).toEqual(
      Object.fromEntries(current.map((row) => [row.listingId, row.fence])),
    );
    expect(stored.options.statuses).toEqual(
      Object.fromEntries(ids.map((id) => [id, "needs_info"])),
    );
    expect(
      listingInputDigest({
        id: stored.id,
        workspaceId: fixture.workspaceId,
        actorId: fixture.userId,
        expiresAt: preview.expiresAt,
        options: stored.options,
      }),
    ).toBe(preview.digest);
    expect(
      await db.forWorkspace(fixture.workspaceId, (repos) =>
        repos.platformProducts.getMaintenanceByIds(ids),
      ),
    ).toEqual(current);
    expect(await admissionCounts()).toEqual(before);
    expect(admissionRequests).toEqual([]);
    expect(errors).toEqual([]);
    await info.attach("synthetic-100-cross-page-preview-observations", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          synthetic: true,
          importedProducts: 100,
          pageSize: 25,
          pages: 4,
          uniqueSelected: 100,
          selectedOutsideLastPage: 75,
          requestedFields: ["nameZh"],
          selectedCount: 100,
          eligibleCount: 100,
          currentInputRevision: 2,
          currentSourceFences: 100,
          actualCredentialSession: true,
          nonBypassForcedRls: true,
          fakeProviderCalls: 0,
          admittedRuns: 0,
          batchesCreated: 0,
          usd: 0,
          previewRows: 1,
          previewScope: "workspace plus authenticated actor",
          productionOrMerchantOriginVerified: false,
        }),
      ),
    });
  } finally {
    await db.close();
    await admin.end();
  }
});
