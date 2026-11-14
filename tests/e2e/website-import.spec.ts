import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "../../packages/db/src/client.js";
import postgres from "postgres";
import {
  ADMIN_URL,
  RUNTIME_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";
import { verifyWebsiteAudit } from "../../packages/db/src/cli/audit-verify.js";
test.describe.configure({ mode: "serial" });
test.skip(
  process.env.PLAYWRIGHT_E2E !== "1",
  "Requires explicit isolated real stack",
);
test("signed website scan saves immutable evidence without a connection across locale and viewport matrix", async ({
  page,
}, testInfo) => {
  const fixture = await prepareBulkImportFixture();
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await admin`update memberships set role='reviewer' where workspace_id=${fixture.workspaceId}`;
    await signInBulkImportOperator(page, fixture, false);
    await page
      .getByRole("button", { name: "Reference only", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Catalog import", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Website", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel(/access token/i)).toHaveCount(0);
    await page.getByRole("tab", { name: "Website", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "Workbook", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page
      .getByLabel("Website URL", { exact: true })
      .fill("https://website.synthetic.example/");
    await page
      .getByRole("button", { name: "Preview products", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: /Queued|Scanning/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "Sample bottle", exact: true }),
    ).toBeEnabled({ timeout: 90_000 });
    const scanId = new URL(page.url()).searchParams.get("scan")!;
    expect(scanId).toBeTruthy();
    await page.reload();
    await expect(
      page.getByRole("checkbox", { name: "Sample bottle", exact: true }),
    ).toBeEnabled();
    const evidence = page.locator("details.website-evidence");
    await expect(evidence).not.toHaveAttribute("open", "");
    await evidence.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(evidence).toHaveAttribute("open", "");
    await expect(
      page.getByText("JSON-LD structured data").first(),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    for (const locale of ["en", "zh-Hant"]) {
      await page
        .context()
        .addCookies([
          { name: "locale", value: locale, url: "http://127.0.0.1:49217" },
        ]);
      for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.reload();
        await expect(
          page.getByRole("heading", { name: "Sample bottle", exact: true }),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`website-${locale}-${width}.png`),
          fullPage: true,
        });
      }
    }
    await page
      .context()
      .addCookies([
        { name: "locale", value: "en", url: "http://127.0.0.1:49217" },
      ]);
    await page.reload();
    await page
      .getByRole("checkbox", { name: "Sample bottle", exact: true })
      .check();
    const saving = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/website-scans/${scanId}/save`) &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save selected products", exact: true })
      .click();
    const response = await saving;
    expect(response.status()).toBe(200);
    const result = await response.json();
    await expect(
      page.getByText("1 product saved", { exact: false }),
    ).toBeVisible();
    const [saved] =
      await admin`select observation from website_products where workspace_id=${fixture.workspaceId} and id=${result.savedIds[0]}`;
    expect(saved!.observation).toMatchObject({
      title: "Sample bottle",
      sourceUrl: "https://website.synthetic.example/products/bottle",
      price: { amount: "128.00", currency: "HKD" },
    });
    const snapshot = await page.request
      .get(`/api/website-scans/${scanId}`)
      .then((r) => r.json());
    expect(saved!.observation).toEqual(snapshot.products[0]);
    const digest = createHash("sha256")
      .update(JSON.stringify(saved!.observation))
      .digest("hex");
    await testInfo.attach("saved-observation-evidence", {
      body: JSON.stringify({
        scanId,
        productId: result.savedIds[0],
        digest,
        observation: saved!.observation,
      }),
      contentType: "application/json",
    });
    const connections =
      await admin`select id from shopline_connections where workspace_id=${fixture.workspaceId}`;
    expect(connections).toHaveLength(0);
    const audit = await verifyWebsiteAudit({
      workspaceId: fixture.workspaceId,
      scanId,
      url: RUNTIME_URL,
    });
    expect(audit.missingActions).toEqual([]);
    expect(audit.accessibleForeignRecordCount).toBe(0);
    await testInfo.attach("website-audit", {
      body: JSON.stringify(audit),
      contentType: "application/json",
    });
    await page.getByRole("link", { name: "View catalog", exact: true }).click();
    await expect(
      page.getByText("Sample bottle", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /View details/ }).click();
    await expect(
      page.getByText("Synthetic bottle description", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await admin.end();
  }
});
test("partial preview and retry retain evidence until the replacement completes", async ({
  page,
}, testInfo) => {
  const fixture = await prepareBulkImportFixture();
  await signInBulkImportOperator(page, fixture, false);
  await page
    .getByRole("button", { name: "Reference only", exact: true })
    .click();
  await page
    .getByLabel("Website URL", { exact: true })
    .fill("https://website.synthetic.example/partial");
  await page
    .getByRole("button", { name: "Preview products", exact: true })
    .click();
  await expect(page.getByText(/Partial preview:/)).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    page.getByText(
      "Some pages could not be read. The preview may be incomplete.",
      { exact: true },
    ),
  ).toBeVisible();
  const prior = new URL(page.url()).searchParams.get("scan");
  await page
    .getByRole("checkbox", { name: "Sample bottle", exact: true })
    .check();
  await page.getByRole("button", { name: "Retry scan", exact: true }).click();
  await expect(page.getByText(/Previous preview:/)).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByRole("checkbox", { name: "Sample bottle", exact: true }),
  ).toBeDisabled({ timeout: 30000 });
  await page.screenshot({
    path: testInfo.outputPath("website-retained-retry.png"),
    fullPage: true,
  });
  // Delivery retry preserves this replacement; the final preview/identity assertions still apply.
  const retryDelivery = page.getByRole("button", {
    name: "Retry delivery",
    exact: true,
  });
  if (await retryDelivery.isVisible()) await retryDelivery.click();
  await expect(page.getByText(/Partial preview:/)).toBeVisible({
    timeout: 90_000,
  });
  expect(new URL(page.url()).searchParams.get("scan")).not.toBe(prior);
  await expect(
    page.getByRole("checkbox", { name: "Sample bottle", exact: true }),
  ).not.toBeChecked({ timeout: 30000 });
  await page.screenshot({
    path: testInfo.outputPath("website-partial.png"),
    fullPage: true,
  });
});

test("a persisted failed website delivery resumes the same scan after reload and explicit keyboard retry", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await prepareBulkImportFixture();
  const database = createDatabase(RUNTIME_URL);
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const failed = await database.forWorkspace(
      fixture.workspaceId,
      async (repositories) => {
        const created = await repositories.websiteCatalog.createScan({
          url: "https://website.synthetic.example/partial",
          requestKey: randomUUID(),
          requestedBy: fixture.userId,
        });
        // Deterministic injected enqueue failure; recovery still uses the real authenticated API and Queue.
        await repositories.websiteCatalog.recordDispatch({
          scanId: created.id,
          revision: created.revision,
          status: "failed",
          now: new Date(),
        });
        return repositories.websiteCatalog.getScan(created.id);
      },
    );
    expect(failed).not.toBeNull();
    let createPosts = 0,
      retryPosts = 0;
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      if (path === "/api/website-scans") createPosts++;
      if (path === `/api/website-scans/${failed!.id}/retry`) retryPosts++;
    });
    await signInBulkImportOperator(page, fixture, false);
    await page.goto(`/listings/import?scan=${failed!.id}`);
    await page
      .getByRole("button", { name: "Reference only", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry delivery", exact: true }),
    ).toBeEnabled();
    expect(createPosts).toBe(0);
    expect(retryPosts).toBe(0);
    await page.reload();
    await page
      .getByRole("button", { name: "Reference only", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry delivery", exact: true }),
    ).toBeEnabled();
    expect(createPosts).toBe(0);
    expect(retryPosts).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "繁中", exact: true }).click();
    const retry = page.getByRole("button", { name: "重試傳送", exact: true });
    await expect(retry).toBeEnabled();
    const retryResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/website-scans/${failed!.id}/retry` &&
        response.request().method() === "POST",
    );
    await retry.focus();
    await retry.press("Enter");
    expect((await retryResponse).status()).toBe(202);
    await expect(page.getByText(/部分預覽：/)).toBeVisible({ timeout: 90_000 });
    expect(new URL(page.url()).searchParams.get("scan")).toBe(failed!.id);
    expect(createPosts).toBe(0);
    expect(retryPosts).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("website-dispatch-recovered-390-zh.png"),
      fullPage: true,
    });
    const replay = await page.request.post(
      `/api/website-scans/${failed!.id}/retry`,
      {
        data: {
          revision: failed!.revision,
          attempts: failed!.dispatchAttempts,
        },
      },
    );
    expect(replay.status()).toBe(409);
    const rows =
      await admin`select id, requested_url, deadline_at from website_scans where workspace_id=${fixture.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(failed!.id);
    expect(rows[0]!.requested_url).toBe(failed!.requestedUrl);
    expect(rows[0]!.deadline_at).toEqual(failed!.deadlineAt);
    const claims =
      await admin`select actor_id from audit_events where workspace_id=${fixture.workspaceId} and entity_id=${failed!.id} and action='website.scan_dispatch_requested' and metadata->>'revision'='0'`;
    expect(claims).toHaveLength(1);
    expect(claims[0]!.actor_id).toBe(fixture.userId);
    const audit = await verifyWebsiteAudit({
      workspaceId: fixture.workspaceId,
      scanId: failed!.id,
      url: RUNTIME_URL,
    });
    expect(audit.missingActions).toEqual([]);
    expect(audit.accessibleForeignRecordCount).toBe(0);
    await testInfo.attach("website-dispatch-recovery-audit", {
      body: JSON.stringify(audit),
      contentType: "application/json",
    });
  } finally {
    await database.close();
    await admin.end();
  }
});
