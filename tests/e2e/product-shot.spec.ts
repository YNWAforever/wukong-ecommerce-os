import {
  expect,
  request as playwrightRequest,
  test,
  type Page,
} from "@playwright/test";
import {
  createProductShotListing,
  enrollAndSignInOpakAdmin,
  prepareRealStackFixture,
  PRODUCT_SHOT_PNGS,
  productShotDatabaseView,
  OPAK_ADMIN_EMAIL,
  OPAK_ADMIN_PASSWORD,
} from "./real-stack-fixture.js";

type Locale = "en" | "zh-Hant";
const BASE_URL = "http://127.0.0.1:49217";
const confirmationFields = [
  "nameZh",
  "summaryEn",
  "summaryZh",
  "seoTitleEn",
  "seoTitleZh",
  "seoDescriptionEn",
  "seoDescriptionZh",
  "seoKeywords",
] as const;
const negativeConfirmations = [
  "priceUnchanged",
  "membershipUnchanged",
  "categoryUnchanged",
  "statusUnchanged",
  "supplierUnchanged",
  "quantityDeltaNeutral",
  "noImageChange",
] as const;
const allTrue = (keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, true]));
const copy = {
  en: {
    heading: "White-background image review",
    compare: "Compare the original photo with the final white-background image",
    original: "Original photo",
    final: "Final white-background image",
    choose: "Choose one main photo",
    use: "Use this photo",
    accept: "Accept this exact image",
    accepted: "Image accepted",
    approve: "Approve listing",
    unknown: /unknown and may already have been charged/,
    failed: "Image processing failed. You can start a fresh attempt.",
    charge: "I understand a fresh attempt may incur another charge.",
    fresh: "Start a fresh attempt",
    replace: "Replace photo",
    replaceFile: "Replacement photo file",
  },
  "zh-Hant": {
    heading: "白底商品照審閱",
    compare: "請比較原相片與最終白底商品照",
    original: "原相片",
    final: "最終白底商品照",
    choose: "請選擇一張主相片",
    use: "使用這張相片",
    accept: "接受此最終商品照",
    accepted: "已接受商品照",
    approve: "批准上架",
    unknown: /上次處理結果不明，可能已收費/,
    failed: "商品照處理失敗，可開始新嘗試",
    charge: "我明白新嘗試可能再次收費。",
    fresh: "開始新嘗試",
    replace: "\u66f4\u63db\u76f8\u7247",
    replaceFile: "\u66f4\u63db\u5546\u54c1\u76f8\u7247\u6a94\u6848",
  },
} as const;

let enrolled = false;
async function signInWithLocale(page: Page, locale: Locale) {
  if (!enrolled) {
    await enrollAndSignInOpakAdmin(page);
    enrolled = true;
  } else {
    await page
      .context()
      .addCookies([{ name: "locale", value: "en", url: BASE_URL }]);
    await page.goto("/signin");
    await page.getByLabel("Email address").fill(OPAK_ADMIN_EMAIL);
    await page
      .getByLabel("Password", { exact: true })
      .fill(OPAK_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  }
  await page
    .context()
    .addCookies([{ name: "locale", value: locale, url: BASE_URL }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1",
    "Requires isolated local services",
  );
  await prepareRealStackFixture();
});

for (const locale of ["en", "zh-Hant"] as const) {
  test(`${locale}: success, replacement, privacy, and eligibility workflow`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signInWithLocale(page, locale);
    const t = copy[locale];
    await page.goto("/listings/new");
    await page.locator("#listing-files").setInputFiles({
      name: `browser-original-${locale}.png`,
      mimeType: "image/png",
      buffer: PRODUCT_SHOT_PNGS.success,
    });
    await page
      .locator("#listing-note")
      .fill(
        `Synthetic Estate Riesling wine 2024, Germany, Mosel, Riesling, 750ml, 12.5% ABV, SKU SHOT-${locale === "en" ? "EN" : "ZH"}-001, HK$288, stock 12`,
      );
    await page.getByRole("button", { name: /Create listing draft/ }).click();
    await expect(page).toHaveURL(
      /\/listings\/[0-9a-f-]{36}\?processing=queued$/i,
    );
    const listingId = page.url().match(/\/listings\/([0-9a-f-]{36})/i)?.[1];
    expect(listingId).toBeTruthy();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByRole("heading", { name: t.heading })).toBeVisible();
    await expect(page.getByText(t.compare)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByAltText(t.original)).toBeVisible();
    await expect(page.getByAltText(t.final)).toBeVisible();

    const beforeListing = await page.request
      .get(`/api/listings/${listingId}`)
      .then((r) => r.json());
    const beforeShot = await page.request
      .get(`/api/listings/${listingId}/product-shot`)
      .then((r) => r.json());
    const uploaded = await productShotDatabaseView(listingId!);
    expect(uploaded.sources).toHaveLength(1);
    const one = {
      listingId: listingId!,
      versionId: beforeShot.expectedVersionId as string,
      sources: uploaded.sources.map((source) => source.id),
      sourceKeys: uploaded.sources.map((source) => source.storageKey),
    };
    expect(
      (await productShotDatabaseView(one.listingId)).attempts[0]?.callCount,
    ).toBe(1);
    const reused = await page.request.post(
      `/api/listings/${one.listingId}/product-shot`,
      {
        data: {
          sourceAssetId: one.sources[0],
          expectedVersionId: one.versionId,
          explicitFreshAttempt: false,
        },
      },
    );
    expect(reused.status()).toBe(200);
    await page.reload();
    await expect(page.getByAltText(t.final)).toBeVisible();
    expect(
      (await productShotDatabaseView(one.listingId)).attempts[0]?.callCount,
    ).toBe(1);
    const afterListing = await page.request
      .get(`/api/listings/${one.listingId}`)
      .then((r) => r.json());
    const afterShot = await page.request
      .get(`/api/listings/${one.listingId}/product-shot`)
      .then((r) => r.json());
    expect(afterListing.activeVersion).toEqual(beforeListing.activeVersion);
    expect(afterShot.candidateDigest).toBe(beforeShot.candidateDigest);

    await page.getByRole("button", { name: t.accept }).click();
    await expect(page.getByText(t.accepted)).toBeVisible();
    const initialSourceAssetId = afterShot.sourceAssetId as string;
    const replaceButton = page.getByRole("button", { name: t.replace });
    await replaceButton.focus();
    await expect(replaceButton).toBeFocused();
    await page.getByLabel(t.replaceFile).setInputFiles({
      name: `browser-replacement-${locale}.png`,
      mimeType: "image/png",
      buffer: PRODUCT_SHOT_PNGS.success,
    });
    let replacementShot = {
      sourceAssetId: "",
      candidatePreviewUrl: "",
      state: "",
    };
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/listings/${one.listingId}/product-shot`,
          );
          if (!response.ok()) return `http_${response.status()}`;
          const current = await response.json();
          if (current.sourceAssetId === initialSourceAssetId)
            return "previous_source";
          replacementShot = current;
          return current.state;
        },
        { timeout: 60_000 },
      )
      .toBe("candidate_ready");
    // The old preview remains visible during upload. Observe the replacement
    // artifact itself instead of letting that previous image satisfy readiness.
    const candidatePath = new URL(replacementShot.candidatePreviewUrl).pathname;
    await expect
      .poll(
        async () => {
          const src = await page.getByAltText(t.final).getAttribute("src");
          return src ? new URL(src, BASE_URL).pathname : null;
        },
        { timeout: 60_000 },
      )
      .toBe(candidatePath);
    await expect(page.getByAltText(t.final)).toBeVisible();
    await expect(page.getByRole("button", { name: t.accept })).toBeVisible();
    const replacementListing = await page.request
      .get(`/api/listings/${one.listingId}`)
      .then((response) => response.json());
    expect(replacementListing.activeVersion).toEqual(
      beforeListing.activeVersion,
    );
    const replaced = await productShotDatabaseView(one.listingId);
    expect(replaced.sources).toHaveLength(2);
    expect(replaced.attempts.map((attempt) => attempt.callCount)).toEqual([
      1, 1,
    ]);
    await page.reload();
    await expect(page.getByAltText(t.final)).toBeVisible();
    expect(
      await page.request
        .get(`/api/listings/${one.listingId}/product-shot`)
        .then((response) => response.json())
        .then((view) => view.sourceAssetId),
    ).toBe(replacementShot.sourceAssetId);

    const several = await createProductShotListing([
      PRODUCT_SHOT_PNGS.success,
      PRODUCT_SHOT_PNGS.ambiguous,
    ]);
    await page.goto(`/listings/${several.listingId}`);
    await expect(page.getByText(t.choose)).toBeVisible();
    await page.locator(`input[value="${several.sources[0]}"]`).check();
    await page.getByRole("button", { name: t.use }).click();
    await expect(page.getByAltText(t.final)).toBeVisible({ timeout: 60_000 });
    const old = await page.request
      .get(`/api/listings/${several.listingId}/product-shot`)
      .then((r) => r.json());
    await page.getByRole("button", { name: t.accept }).click();
    await expect(page.getByText(t.accepted)).toBeVisible();
    await page.locator(`input[value="${several.sources[1]}"]`).check();
    await page.getByRole("button", { name: t.use }).click();
    await expect(page.getByText(t.unknown)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: t.accept })).toHaveCount(0);
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
    expect(stale.status(), await stale.text()).toBe(409);

    await page.goto(`/listings/${one.listingId}`);
    await page.getByRole("button", { name: t.accept }).click();
    await expect(page.getByText(t.accepted)).toBeVisible();
    await expect(
      page.getByRole("button", { name: t.approve, exact: true }),
    ).toBeDisabled();
    const completedLedger = await page.request.patch(
      `/api/listings/${one.listingId}/review-confirmations`,
      {
        data: {
          versionId: one.versionId,
          fieldConfirmations: allTrue(confirmationFields),
          negativeConfirmations: allTrue(negativeConfirmations),
        },
      },
    );
    expect(completedLedger.status()).toBe(200);
    const approved = await page.request.post(
      `/api/listings/${one.listingId}/approve`,
      {
        data: {
          expectedVersionId: one.versionId,
          confirmationLedgerRevision: (await completedLedger.json()).revision,
        },
      },
    );
    expect(approved.status()).toBe(200);
    const approvedVersionId = (await approved.json()).versionId;
    const beforeConfirmationWithdrawal = await page.request
      .get(`/api/listings/${one.listingId}`)
      .then((response) => response.json());
    expect(beforeConfirmationWithdrawal.status).toBe("approved");
    expect(beforeConfirmationWithdrawal.activeVersion.id).toBe(
      approvedVersionId,
    );
    const incompleteLedger = await page.request.patch(
      `/api/listings/${one.listingId}/review-confirmations`,
      {
        data: {
          versionId: approvedVersionId,
          fieldConfirmations: {},
          negativeConfirmations: {},
        },
      },
    );
    expect(incompleteLedger.status()).toBe(200);
    const afterConfirmationWithdrawal = await page.request
      .get(`/api/listings/${one.listingId}`)
      .then((response) => response.json());
    expect(afterConfirmationWithdrawal.status).toBe("reopened");
    expect(afterConfirmationWithdrawal.activeVersion.id).toBe(
      approvedVersionId,
    );
    const blockedApproval = await page.request.post(
      `/api/listings/${one.listingId}/approve`,
      {
        data: {
          expectedVersionId: approvedVersionId,
          confirmationLedgerRevision: (await incompleteLedger.json()).revision,
        },
      },
    );
    expect(blockedApproval.status()).toBe(422);
    expect((await blockedApproval.json()).code).toBe("confirmation_incomplete");
    const blockedExport = await page.request.post(
      `/api/listings/${one.listingId}/deliver`,
      { data: { method: "csv" } },
    );
    expect(blockedExport.status()).toBe(409);
    expect((await blockedExport.json()).code).toBe("image_approval_required");

    const published = await productShotDatabaseView(one.listingId);
    expect(published.publicUrl).toMatch(
      /^https:\/\/localhost:49218\/product-images\/[A-Za-z0-9_-]{43}\.jpg$/,
    );
    const anonymous = await playwrightRequest.newContext({
      ignoreHTTPSErrors: true,
    });
    try {
      const image = await anonymous.get(published.publicUrl!);
      expect(image.status()).toBe(200);
      expect(image.headers()["content-type"]).toMatch(/^image\/jpeg/);
      expect(
        (
          await anonymous.get(
            "https://localhost:49218/product-images/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.jpg",
          )
        ).status(),
      ).toBe(404);
      expect(
        (
          await anonymous.get(
            `https://localhost:9012/${process.env.S3_BUCKET}/${one.sourceKeys[0]}`,
          )
        ).status(),
      ).toBe(403);
    } finally {
      await anonymous.dispose();
    }
  });

  test(`${locale}: definitive and ambiguous retries use the real Queue`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signInWithLocale(page, locale);
    const t = copy[locale];
    const failed = await createProductShotListing([
      PRODUCT_SHOT_PNGS.definitiveFailure,
    ]);
    await page.goto(`/listings/${failed.listingId}`);
    await expect(page.getByText(t.failed)).toBeVisible({ timeout: 60_000 });
    expect(
      (await productShotDatabaseView(failed.listingId)).attempts.map(
        (a) => a.callCount,
      ),
    ).toEqual([1]);
    await page.getByLabel(t.charge).check();
    await page.getByRole("button", { name: t.fresh }).click();
    await expect
      .poll(async () => {
        const attempts = (await productShotDatabaseView(failed.listingId))
          .attempts;
        return attempts.length === 2
          ? attempts.map((a) => `${a.state}:${a.callCount}`)
          : [];
      })
      .toEqual(["failed:1", "failed:1"]);

    const unknown = await createProductShotListing([
      PRODUCT_SHOT_PNGS.ambiguous,
    ]);
    await page.goto(`/listings/${unknown.listingId}`);
    await expect(page.getByText(t.unknown)).toBeVisible({ timeout: 60_000 });
    const start = page.getByRole("button", { name: t.fresh });
    await expect(start).toBeDisabled();
    await page.getByLabel(t.charge).check();
    await expect(start).toBeEnabled();
    await start.click();
    await expect
      .poll(async () => {
        const attempts = (await productShotDatabaseView(unknown.listingId))
          .attempts;
        return attempts.length === 2
          ? attempts.map((a) => `${a.state}:${a.callCount}`)
          : [];
      })
      .toEqual(["outcome_unknown:1", "outcome_unknown:1"]);
  });
}
