import { expect, request as playwrightRequest, test } from "@playwright/test";
import {
  createProductShotListing,
  enrollAndSignInOpakAdmin,
  prepareRealStackFixture,
  PRODUCT_SHOT_PNGS,
  productShotDatabaseView,
  OPAK_ADMIN_EMAIL,
  OPAK_ADMIN_PASSWORD,
} from "./real-stack-fixture.js";
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1",
    "Requires isolated local services",
  );
  await prepareRealStackFixture();
});
test("English review selects sources, preserves drafts, reuses checkpoints, rejects stale approval, and publishes only the accepted JPEG", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await enrollAndSignInOpakAdmin(page);
  const one = await createProductShotListing([PRODUCT_SHOT_PNGS.success]);
  await page.goto(`/listings/${one.listingId}`);
  await expect(
    page.getByRole("heading", { name: "White-background image review" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Compare the original photo with the final white-background image",
    ),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByAltText("Original photo")).toBeVisible();
  await expect(page.getByAltText("Final white-background image")).toBeVisible();
  const beforeReuse = await page.request
    .get(`/api/listings/${one.listingId}`)
    .then((r) => r.json());
  const beforeShot = await page.request
    .get(`/api/listings/${one.listingId}/product-shot`)
    .then((r) => r.json());
  expect(
    (await productShotDatabaseView(one.listingId)).attempts[0]?.callCount,
  ).toBe(1);
  expect(
    (
      await page.request.post(`/api/listings/${one.listingId}/product-shot`, {
        data: {
          sourceAssetId: one.sources[0],
          expectedVersionId: one.versionId,
          explicitFreshAttempt: false,
        },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await expect(page.getByAltText("Final white-background image")).toBeVisible();
  expect(
    (await productShotDatabaseView(one.listingId)).attempts[0]?.callCount,
  ).toBe(1);
  const afterReuse = await page.request
    .get(`/api/listings/${one.listingId}`)
    .then((r) => r.json());
  const afterShot = await page.request
    .get(`/api/listings/${one.listingId}/product-shot`)
    .then((r) => r.json());
  expect(afterReuse.activeVersion).toEqual(beforeReuse.activeVersion);
  expect(afterShot.candidateDigest).toBe(beforeShot.candidateDigest);
  const several = await createProductShotListing([
    PRODUCT_SHOT_PNGS.success,
    PRODUCT_SHOT_PNGS.ambiguous,
  ]);
  await page.goto(`/listings/${several.listingId}`);
  await expect(page.getByText("Choose one main photo")).toBeVisible();
  await page.locator(`input[value="${several.sources[0]}"]`).check();
  await page.getByRole("button", { name: "Use this photo" }).click();
  await expect(page.getByAltText("Final white-background image")).toBeVisible({
    timeout: 60_000,
  });
  const old = await page.request
    .get(`/api/listings/${several.listingId}/product-shot`)
    .then((r) => r.json());
  await page.getByRole("button", { name: "Accept this exact image" }).click();
  await expect(page.getByText("Image accepted")).toBeVisible();
  await page.locator(`input[value="${several.sources[1]}"]`).check();
  await page.getByRole("button", { name: "Use this photo" }).click();
  await expect(
    page.getByText(/unknown and may already have been charged/),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("button", { name: "Accept this exact image" }),
  ).toHaveCount(0);
  const stale = await page.request.post(
    `/api/listings/${several.listingId}/product-shot/approve`,
    {
      data: {
        attemptId: old.attemptId,
        expectedVersionId: old.expectedVersionId,
        candidateDigest: old.candidateDigest,
      },
    },
  );
  const staleBody = await stale.text();
  expect(stale.status(), JSON.stringify({ staleBody, old })).toBe(409);
  await page.goto(`/listings/${one.listingId}`);
  await page.getByRole("button", { name: "Accept this exact image" }).click();
  await expect(page.getByText("Image accepted")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve listing", exact: true }),
  ).toBeDisabled();
  const incompleteLedger = await page.request.patch(
    `/api/listings/${one.listingId}/review-confirmations`,
    {
      data: {
        versionId: one.versionId,
        fieldConfirmations: {},
        negativeConfirmations: {},
      },
    },
  );
  expect(incompleteLedger.status()).toBe(200);
  const incompleteRevision = (await incompleteLedger.json()).revision;
  const blockedApproval = await page.request.post(
    `/api/listings/${one.listingId}/approve`,
    {
      data: {
        expectedVersionId: one.versionId,
        confirmationLedgerRevision: incompleteRevision,
      },
    },
  );
  expect(blockedApproval.status()).toBe(422);
  expect((await blockedApproval.json()).code).toBe("confirmation_incomplete");
  const blockedExport = await page.request.post(
    `/api/listings/${one.listingId}/deliver`,
    {
      data: { method: "csv" },
    },
  );
  expect(blockedExport.status()).toBe(409);
  expect((await blockedExport.json()).code).toBe("image_approval_required");
  const published = await productShotDatabaseView(one.listingId);
  expect(published.publicUrl).toMatch(
    /^https:\/\/localhost:49218\/product-images\/[A-Za-z0-9_-]{43}\.jpg$/,
  );
  const anonymousContext = await playwrightRequest.newContext({
    ignoreHTTPSErrors: true,
  });
  try {
    const anonymous = await anonymousContext.get(published.publicUrl!);
    expect(anonymous.status()).toBe(200);
    expect(anonymous.headers()["content-type"]).toMatch(/^image\/jpeg/);
    const unapproved = await anonymousContext.get(
      "https://localhost:49218/product-images/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.jpg",
    );
    expect(unapproved.status()).toBe(404);
    const original = await anonymousContext.get(
      `https://localhost:9012/${process.env.S3_BUCKET}/${one.sourceKeys[0]}`,
    );
    expect(original.status()).toBe(403);
  } finally {
    await anonymousContext.dispose();
  }
});
test("Traditional Chinese exposes definitive failure retry and ambiguous-charge confirmation through the real Queue", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/signin");
  await page
    .context()
    .addCookies([
      { name: "locale", value: "en", url: "http://127.0.0.1:49217" },
    ]);
  await page.reload();
  await page.getByLabel("Email address").fill(OPAK_ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(OPAK_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page
    .context()
    .addCookies([
      { name: "locale", value: "zh-Hant", url: "http://127.0.0.1:49217" },
    ]);
  const failed = await createProductShotListing([
    PRODUCT_SHOT_PNGS.definitiveFailure,
  ]);
  await page.goto(`/listings/${failed.listingId}`);
  await expect(page.getByText("商品照處理失敗，可開始新嘗試")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("我明白新嘗試可能再次收費。")).toBeVisible();
  expect(
    (await productShotDatabaseView(failed.listingId)).attempts.map(
      (a) => a.callCount,
    ),
  ).toEqual([1]);
  await page.getByLabel("我明白新嘗試可能再次收費。").check();
  await page.getByRole("button", { name: "開始新嘗試" }).click();
  await expect
    .poll(async () => {
      const attempts = (await productShotDatabaseView(failed.listingId))
        .attempts;
      return attempts.length === 2
        ? attempts.map((attempt) => `${attempt.state}:${attempt.callCount}`)
        : [];
    })
    .toEqual(["failed:1", "failed:1"]);
  const unknown = await createProductShotListing([PRODUCT_SHOT_PNGS.ambiguous]);
  await page.goto(`/listings/${unknown.listingId}`);
  await expect(page.getByText("上次處理結果不明，可能已收費")).toBeVisible({
    timeout: 60_000,
  });
  const start = page.getByRole("button", { name: "開始新嘗試" });
  await expect(start).toBeDisabled();
  await page.getByLabel("我明白新嘗試可能再次收費。").check();
  await expect(start).toBeEnabled();
  await start.click();
  await expect
    .poll(async () => {
      const attempts = (await productShotDatabaseView(unknown.listingId))
        .attempts;
      return attempts.length === 2
        ? attempts.map((attempt) => `${attempt.state}:${attempt.callCount}`)
        : [];
    })
    .toEqual(["outcome_unknown:1", "outcome_unknown:1"]);
});
