import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  GetOutputResult,
  GetThreadResult,
} from "../../apps/web/lib/studio/contracts";
import type { StudioReviewBatchResult } from "../../apps/web/lib/studio/review-batch";

/**
 * Bounded multi-listing review acceptance (2026-11-16 plan, PR 3).
 *
 * Runs against the isolated loopback Studio fixture with the deterministic
 * audit/gap stages — no provider is configured and no model may be called. It
 * proves the operator-facing promise end to end: two selected listings get one
 * explicit request, each lands in its own guided thread with exact recorded
 * pins, a reload rebuilds the same state from the database, canonical listing
 * data is untouched, the cap/privacy/role rules hold, and the surface fits a
 * 390px Traditional Chinese viewport.
 */

test.skip(
  process.env.STUDIO_GUIDED_ACCEPTANCE !== "1",
  "Requires the isolated loopback-only Studio fixture.",
);

const LISTING_A = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a01";
const LISTING_B = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a10";
const MISSING = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a99";
const FOREIGN = "6c27b9d3-2a4a-4b6b-9e9e-2f0f0b6f7a0d";
const PASSWORD = "Local-only studio browser password 1!";
const EVIDENCE = "node_modules/.studio-evidence";

const policy = {
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  pricingVersion: "opencode-go-2026-11",
  maxInputTokens: 1048576,
  inputUsdPerMillion: "0.3",
  outputUsdPerMillion: "1.2",
  maxOutputTokens: 4096,
};

async function signIn(
  page: Page,
  baseURL: string,
  viewer = false,
): Promise<void> {
  await page
    .context()
    .addCookies([{ name: "locale", value: "en", url: baseURL }]);
  await page.goto("/signin");
  await page
    .getByLabel("Email address")
    .fill(
      viewer
        ? "studio-browser-viewer@local.invalid"
        : "studio-browser-e2e@local.invalid",
    );
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /^Sign in with/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}

function configuration(settings: Record<string, unknown>) {
  return {
    enabled: settings.enabled,
    allowedSkills: settings.allowedSkills,
    monthlyBudgetUsd: settings.monthlyBudgetUsd,
    runCeilingUsd: settings.runCeilingUsd,
    retentionDays: settings.retentionDays,
    defaultHome: settings.defaultHome,
    ai: settings.ai,
  };
}

async function patchSettings(
  page: Page,
  data: Record<string, unknown>,
): Promise<void> {
  const response = await page.request.patch("/api/studio/settings", { data });
  expect(response.status(), await response.text()).toBe(200);
}

async function readBatchPins(
  page: Page,
  item: StudioReviewBatchResult["items"][number],
): Promise<{ model: string | null; reservedUsd: string | null }> {
  if (!item.audit) throw new Error("Expected a recorded audit");
  const detailResponse = await page.request.get(
    `/api/studio/outputs/${item.audit.outputId}`,
  );
  expect(detailResponse.status()).toBe(200);
  const detail = (await detailResponse.json()) as GetOutputResult;
  expect(detail.output.threadId).toBe(item.threadId);
  const version = detail.versions.find(
    (value) => value.revision === item.audit!.revision,
  );
  expect(version?.contentDigest).toBe(item.audit.contentDigest);
  if (!item.threadId) throw new Error("Expected the audit thread");
  const threadResponse = await page.request.get(
    `/api/studio/threads/${item.threadId}`,
  );
  expect(threadResponse.status()).toBe(200);
  const thread = (await threadResponse.json()) as GetThreadResult;
  const runId = thread.latestGuidedAttempt?.runId;
  if (!runId) throw new Error("Expected a recorded guided run");
  const runResponse = await page.request.get(
    `/api/studio/threads/${item.threadId}/runs/${runId}`,
  );
  expect(runResponse.status()).toBe(200);
  const run = (await runResponse.json()) as {
    model: string | null;
    reservedUsd: string | null;
  };
  return { model: run.model, reservedUsd: run.reservedUsd };
}

test("bounded multi-listing review runs both deterministic stages per listing and replays exactly", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Missing fixture URL");
  await signIn(page, baseURL);
  const original = configuration(
    (await (await page.request.get("/api/studio/settings")).json()).settings,
  );
  let reviewPosts = 0;
  let messagePosts = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/studio/reviews")
      reviewPosts++;
    if (
      request.method() === "POST" &&
      /\/api\/studio\/threads\/[^/]+\/messages$/.test(path)
    )
      messagePosts++;
  });
  try {
    await patchSettings(page, {
      ...original,
      enabled: true,
      allowedSkills: [],
      monthlyBudgetUsd: "10",
      runCeilingUsd: "2",
      ai: policy,
    });
    const beforeA = await (
      await page.request.get(`/api/listings/${LISTING_A}`)
    ).json();
    const beforeB = await (
      await page.request.get(`/api/listings/${LISTING_B}`)
    ).json();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/studio/reviews");
    await expect(
      page.getByRole("heading", { name: "Batch review", exact: true }),
    ).toBeVisible();
    const candidateA = page.locator(`[data-listing-id="${LISTING_A}"]`);
    const candidateB = page.locator(`[data-listing-id="${LISTING_B}"]`);
    await expect(candidateA).toBeVisible();
    await expect(candidateB).toBeVisible();
    await candidateA.locator('input[type="checkbox"]').check();
    await candidateB.locator('input[type="checkbox"]').check();
    await expect(page.getByText("2 of 5 listings selected.")).toBeVisible();
    expect(reviewPosts).toBe(0);
    expect(messagePosts).toBe(0);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/studio/reviews",
    );
    await page
      .getByRole("button", { name: "Start review", exact: true })
      .click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const body = (await response.json()) as StudioReviewBatchResult;
    expect(reviewPosts).toBe(1);
    // The whole batch is one explicit server request; the page never posts a
    // guided message itself and never triggers a model.
    expect(messagePosts).toBe(0);
    expect(body.requested).toBe(2);
    expect(body.completed).toBe(2);
    expect(body.partial).toBe(0);
    expect(body.failed).toBe(0);
    const itemA = body.items.find((item) => item.listingId === LISTING_A)!;
    const itemB = body.items.find((item) => item.listingId === LISTING_B)!;
    expect(itemA.threadId).not.toBe(itemB.threadId);
    for (const item of [itemA, itemB]) {
      expect(item.outcome).toBe("complete");
      expect(item.failureCode).toBeNull();
      expect(item.audit?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(item.gap?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      const run = await readBatchPins(page, item);
      expect(run.model).toBeNull();
      expect(run.reservedUsd).toBeNull();
    }

    await page.waitForURL(/listingIds=/);
    const results = page.locator('[data-review-result="true"]');
    await expect(results).toHaveCount(2);
    const outcomes = await results.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-outcome")),
    );
    expect(
      outcomes.every(
        (outcome) => outcome === "complete" || outcome === "recorded",
      ),
    ).toBe(true);
    for (const item of [itemA, itemB]) {
      await expect(
        page.locator(
          `[data-review-result="true"] a[href="/studio/t/${item.threadId}"]`,
        ),
      ).toHaveCount(1);
      await expect(
        page.locator(
          `[data-review-result="true"] a[href="/studio/outputs/${item.audit!.outputId}?revision=${item.audit!.revision}&digest=${item.audit!.contentDigest}"]`,
        ),
      ).toHaveCount(1);
      await expect(
        page.locator(
          `[data-review-result="true"] a[href="/studio/outputs/${item.gap!.outputId}?revision=${item.gap!.revision}&digest=${item.gap!.contentDigest}"]`,
        ),
      ).toHaveCount(1);
    }
    await page.screenshot({
      path: `${EVIDENCE}/studio-review-batch-results.png`,
      fullPage: true,
    });

    // A reload rebuilds the same recorded state from the database only.
    await page.reload();
    await expect(page.locator('[data-review-result="true"]')).toHaveCount(2);
    await expect(
      page.locator('[data-review-result="true"][data-outcome="recorded"]'),
    ).toHaveCount(2);
    expect(reviewPosts).toBe(1);
    expect(messagePosts).toBe(0);

    // Canonical listing data stays unchanged; the review never writes copy.
    const afterA = await (
      await page.request.get(`/api/listings/${LISTING_A}`)
    ).json();
    const afterB = await (
      await page.request.get(`/api/listings/${LISTING_B}`)
    ).json();
    expect(afterA.activeVersion).toEqual(beforeA.activeVersion);
    expect(afterA.status).toBe(beforeA.status);
    expect(afterB.activeVersion).toEqual(beforeB.activeVersion);
    expect(afterB.status).toBe(beforeB.status);

    // Traditional Chinese at 390px keeps the result links readable.
    await page
      .context()
      .addCookies([{ name: "locale", value: "zh-Hant", url: baseURL }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `${new URL("/studio/reviews", baseURL).toString()}?listingIds=${LISTING_A},${LISTING_B}`,
    );
    await expect(
      page.getByRole("heading", { name: "批次審查", exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-review-result="true"]')).toHaveCount(2);
    await expect(
      page.getByText("已記錄", { exact: true }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${EVIDENCE}/studio-review-batch-390-zh.png`,
      fullPage: true,
    });
  } finally {
    await patchSettings(page, original);
  }
});

test("cap, missing listings and role isolation stay honest and read-only", async ({
  page,
  baseURL,
  browser,
}) => {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Missing fixture URL");
  await signIn(page, baseURL);
  const original = configuration(
    (await (await page.request.get("/api/studio/settings")).json()).settings,
  );
  let viewerContext: BrowserContext | null = null;
  try {
    await patchSettings(page, {
      ...original,
      enabled: true,
      allowedSkills: [],
    });

    // One request, two independent outcomes: a listing in another workspace is
    // unavailable alone and never named.
    const mixed = await page.request.post("/api/studio/reviews", {
      data: { listingIds: [LISTING_A, FOREIGN] },
    });
    expect(mixed.status()).toBe(200);
    const mixedBody = (await mixed.json()) as StudioReviewBatchResult;
    expect(mixedBody.requested).toBe(2);
    expect(mixedBody.completed).toBe(1);
    expect(mixedBody.failed).toBe(1);
    expect(
      mixedBody.items.find((item) => item.listingId === LISTING_A)?.outcome,
    ).toBe("complete");
    expect(mixedBody.items.find((item) => item.listingId === FOREIGN)).toEqual({
      listingId: FOREIGN,
      title: "",
      outcome: "failed",
      failureCode: "listing_unavailable",
      threadId: null,
      audit: null,
      gap: null,
    });

    // Over-cap, duplicate and caller-controlled bodies are rejected before any
    // work: the response names the validation failure, not an internal error.
    for (const data of [
      {
        listingIds: [
          LISTING_A,
          LISTING_B,
          MISSING,
          LISTING_A,
          LISTING_B,
          MISSING,
        ],
      },
      { listingIds: [LISTING_A, LISTING_A] },
      { listingIds: [LISTING_A], workspaceId: "ws_foreign" },
      { listingIds: [LISTING_A], locale: "fr" },
    ]) {
      const response = await page.request.post("/api/studio/reviews", { data });
      expect(response.status()).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe(
        "invalid_body",
      );
    }
    const duplicateQuery = await page.request.get(
      `/api/studio/reviews?listingIds=${LISTING_A}&listingIds=${LISTING_B}`,
    );
    expect(duplicateQuery.status()).toBe(400);

    // A missing or foreign listing is unavailable, never named, and carries no
    // artifacts; the selection page cannot show foreign listings either.
    for (const id of [MISSING, FOREIGN]) {
      const unreadable = await page.request.get(
        `/api/studio/reviews?listingIds=${id}`,
      );
      expect(unreadable.status()).toBe(200);
      const unreadableBody = (await unreadable.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(unreadableBody.items).toEqual([
        {
          listingId: id,
          available: false,
          title: "",
          status: null,
          activeVersion: null,
          threadId: null,
          audit: null,
          gap: null,
        },
      ]);
    }
    await page.goto(`${baseURL}/studio/reviews`);
    await expect(page.getByText("Foreign private listing")).toHaveCount(0);

    // A viewer may read recorded state but may not start work.
    viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await viewerContext.addCookies([
      { name: "locale", value: "en", url: baseURL },
    ]);
    await viewerPage.goto(`${baseURL}/signin`);
    await viewerPage
      .getByLabel("Email address")
      .fill("studio-browser-viewer@local.invalid");
    await viewerPage.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await viewerPage.getByRole("button", { name: /^Sign in with/ }).click();
    await viewerPage.waitForURL((url) => !url.pathname.startsWith("/signin"));
    const denied = await viewerPage.request.post("/api/studio/reviews", {
      data: { listingIds: [LISTING_A] },
    });
    expect(denied.status()).toBe(403);
    const viewerRead = await viewerPage.request.get(
      `/api/studio/reviews?listingIds=${LISTING_A}`,
    );
    expect(viewerRead.status()).toBe(200);
    await viewerPage.goto(`${baseURL}/studio/reviews`);
    await expect(
      viewerPage.getByText(
        "An operator or higher role is required to start reviews.",
      ),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("button", { name: "Start review", exact: true }),
    ).toBeDisabled();
    await viewerPage.screenshot({
      path: `${EVIDENCE}/studio-review-batch-viewer.png`,
      fullPage: true,
    });
  } finally {
    await patchSettings(page, original);
    await viewerContext?.close();
  }
});
