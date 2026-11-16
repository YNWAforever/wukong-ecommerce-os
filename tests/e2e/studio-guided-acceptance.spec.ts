import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import type {
  StudioRunResponse,
  GetOutputResult,
} from "../../apps/web/lib/studio/contracts";

test.skip(
  process.env.STUDIO_GUIDED_ACCEPTANCE !== "1",
  "Requires the isolated loopback-only Studio fake-model fixture.",
);
const ID = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a01";
const PASSWORD = "Local-only studio browser password 1!";
async function signIn(
  page: Page,
  baseURL: string,
  viewer = false,
  email?: string,
) {
  await page
    .context()
    .addCookies([{ name: "locale", value: "en", url: baseURL }]);
  await page.goto("/signin");
  await page
    .getByLabel("Email address")
    .fill(
      email ??
        (viewer
          ? "studio-browser-viewer@local.invalid"
          : "studio-browser-e2e@local.invalid"),
    );
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /^Sign in with/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}
async function readRun(
  page: Page,
  threadId: string,
  runId: string,
): Promise<StudioRunResponse> {
  const response = await page.request.get(
    `/api/studio/threads/${threadId}/runs/${runId}`,
  );
  expect(response.status()).toBe(200);
  const run = (await response.json()) as StudioRunResponse;
  expect(run.runId).toBe(runId);
  expect(run.threadId).toBe(threadId);
  return run;
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
const policy = {
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  pricingVersion: "opencode-go-2026-11",
  maxInputTokens: 1048576,
  inputUsdPerMillion: "0.3",
  outputUsdPerMillion: "1.2",
  maxOutputTokens: 4096,
};
async function send(page: Page) {
  const result = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/studio\/threads\/[^/]+\/messages$/.test(
        new URL(response.url()).pathname,
      ),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await result;
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    threadId: string;
    runId: string;
    reply: { outputs: Array<{ outputId: string; revision: number }> };
  };
}

test("guided listing journey uses records, resumes without sending and hands off an exact fake-model proposal", async ({
  page,
  baseURL,
  browser,
}, info) => {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Missing fixture URL");
  await signIn(page, baseURL);
  const original = configuration(
    (await (await page.request.get("/api/studio/settings")).json()).settings,
  );
  const configured = {
    ...original,
    enabled: true,
    allowedSkills: [],
    monthlyBudgetUsd: "10",
    runCeilingUsd: "2",
    ai: policy,
  };
  expect(
    (
      await page.request.patch("/api/studio/settings", { data: configured })
    ).status(),
  ).toBe(200);
  const before = await (await page.request.get(`/api/listings/${ID}`)).json();
  const reviewContexts: BrowserContext[] = [];
  let reviewMessagePosts = 0;
  let messagePosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/studio\/threads\/[^/]+\/messages$/.test(
        new URL(request.url()).pathname,
      )
    )
      messagePosts++;
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/listings/${ID}`);
    const entry = page.getByRole("link", {
      name: "Start guided review",
      exact: true,
    });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page.locator('[data-guided-entry="true"]')).toContainText(
      "audit covers workspace records",
    );
    expect(messagePosts).toBe(0);
    const audit = await send(page);
    await page.waitForURL(/\/studio\/t\//);
    const journey = page.locator('[data-guided-journey="true"]');
    await expect(journey).toContainText("Workspace audit");
    const auditRun = await readRun(page, audit.threadId, audit.runId);
    expect(auditRun.model).toBeNull();
    await page.reload();
    const prepareGap = journey.getByRole("button", {
      name: "Prepare gap review",
      exact: true,
    });
    await expect(prepareGap).toBeEnabled();
    expect(messagePosts).toBe(1);
    const composer = page.locator("textarea");
    await composer.fill("Keep my unsent draft");
    await expect(prepareGap).toBeDisabled();
    await expect(composer).toHaveValue("Keep my unsent draft");
    await composer.fill("");
    await prepareGap.focus();
    await prepareGap.press("Enter");
    const gapConfirm = journey.getByRole("group", {
      name: "Send this request?",
    });
    await expect(gapConfirm).toBeVisible();
    await expect(gapConfirm).toContainText(
      "Review the recorded gaps for the selected listing version.",
    );
    expect(messagePosts).toBe(1);
    const gapPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/studio\/threads\/[^/]+\/messages$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await gapConfirm
      .getByRole("button", { name: "Send request", exact: true })
      .click();
    const gapResponse = await gapPromise;
    expect(gapResponse.status()).toBe(200);
    const gap = await gapResponse.json();
    await expect(journey).toHaveAttribute("data-guided-stage", "gap_review");
    const gapRun = await readRun(page, gap.threadId, gap.runId);
    expect(gapRun.model).toBeNull();
    const gapId = gap.reply.outputs[0]!.outputId;
    const gapDetail = await (
      await page.request.get(`/api/studio/outputs/${gapId}`)
    ).json();
    const gapVersion = gapDetail.versions.find(
      (value: { revision: number }) =>
        value.revision === gap.reply.outputs[0]!.revision,
    );
    await expect(page.locator('[data-kind="gap_report"]')).toContainText(
      "Recorded listing gaps",
    );
    // A missing selected-quality read remains unknown in the UI; it cannot prepare copy.
    await page.route(`**/api/studio/outputs/${gapId}`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.output.freshness = "unavailable";
      data.versions[0].scope.guidedReview.quality = null;
      data.versions[0].payload.listings[0].gaps = null;
      await route.fulfill({ response, json: data });
    });
    await journey
      .getByRole("button", { name: "Refresh journey status", exact: true })
      .click();
    await expect(
      journey.getByRole("button", {
        name: "Prepare copy proposal",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(messagePosts).toBe(2);
    await page.unroute(`**/api/studio/outputs/${gapId}`);
    await journey
      .getByRole("button", { name: "Refresh journey status", exact: true })
      .click();
    await expect(
      journey.getByRole("button", {
        name: "Prepare copy proposal",
        exact: true,
      }),
    ).toBeEnabled();
    await journey
      .getByRole("button", { name: "Prepare copy proposal", exact: true })
      .click();
    const copyConfirm = journey.getByRole("group", {
      name: "Send this request?",
    });
    await expect(copyConfirm).toBeVisible();
    expect(messagePosts).toBe(2);
    const copyPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/studio\/threads\/[^/]+\/messages$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await copyConfirm
      .getByRole("button", { name: "Send request", exact: true })
      .click();
    const copyResponse = await copyPromise;
    expect(copyResponse.status()).toBe(200);
    const copy = await copyResponse.json();
    await expect(journey).toHaveAttribute("data-guided-stage", "copy_proposal");
    expect(messagePosts).toBe(3);
    const run = await readRun(page, copy.threadId, copy.runId);
    expect(run.model).toBe("fake-studio-guided-acceptance");
    expect(
      run.events.filter((event: { kind: string }) => event.kind === "model"),
    ).toHaveLength(1);
    await page.reload();
    await expect(journey).toContainText("save the exact proposal");
    expect(messagePosts).toBe(3);
    const outputId = copy.reply.outputs[0].outputId;
    const outputResponse = await page.request.get(
      `/api/studio/outputs/${outputId}`,
    );
    expect(outputResponse.status()).toBe(200);
    const output = (await outputResponse.json()) as GetOutputResult;
    const version = output.versions.find(
      (entry) => entry.revision === output.output.currentVersion,
    )!;
    const pin = {
      expectedRevision: version.revision,
      expectedDigest: version.contentDigest,
    };
    const pinnedUrl = `/studio/outputs/${outputId}?revision=${version.revision}&digest=${version.contentDigest}`;
    for (const role of ["operator", "reviewer"] as const) {
      const context = await browser.newContext({
        baseURL,
        viewport: { width: 390, height: 844 },
      });
      reviewContexts.push(context);
      const reviewPage = await context.newPage();
      reviewPage.on("request", (request) => {
        if (
          request.method() === "POST" &&
          /\/api\/studio\/threads\/[^/]+\/messages$/.test(
            new URL(request.url()).pathname,
          )
        )
          reviewMessagePosts++;
      });
      await signIn(
        reviewPage,
        baseURL,
        false,
        `studio-browser-${role}@local.invalid`,
      );
      await reviewPage.goto("/studio/inbox");
      // The same pinned artifact is linked from the priority queue and from the
      // collapsed source card; open the queue's visible link.
      const artifactLink = reviewPage
        .locator(`a[href="${pinnedUrl}"]:visible`)
        .first();
      await expect(artifactLink).toBeVisible();
      await artifactLink.focus();
      await artifactLink.press("Enter");
      await expect(reviewPage).toHaveURL(new URL(pinnedUrl, baseURL).href);
      await expect(
        reviewPage.getByText("Acceptance copy proposed for human review.", {
          exact: true,
        }),
      ).toBeVisible();
      const card = reviewPage.locator(`[data-output-id="${outputId}"]`);
      if (role === "operator") {
        await expect(
          card.getByRole("button", { name: "Sign off", exact: true }),
        ).toBeDisabled();
        expect(
          (
            await reviewPage.request.post(`/api/studio/outputs/${outputId}`, {
              data: { action: "sign_off", ...pin },
            })
          ).status(),
        ).toBe(403);
        await card
          .getByRole("button", { name: "Save artifact", exact: true })
          .focus();
        await card
          .getByRole("button", { name: "Save artifact", exact: true })
          .press("Enter");
        await expect(
          card.getByText("Saved", { exact: true }).first(),
        ).toBeVisible();
        const replay = await reviewPage.request.post(
          `/api/studio/outputs/${outputId}`,
          { data: { action: "save", ...pin } },
        );
        expect(replay.status()).toBe(200);
        expect(await replay.json()).toMatchObject({
          replayed: true,
          version: version.revision,
          status: "saved",
        });
        await reviewPage.reload();
        await expect(
          card.getByText("Saved", { exact: true }).first(),
        ).toBeVisible();
        await reviewPage.screenshot({
          path: "node_modules/.studio-evidence/studio-reviewer-operator-390.png",
          fullPage: true,
        });
      } else {
        await card
          .getByRole("button", { name: "Sign off", exact: true })
          .focus();
        await card
          .getByRole("button", { name: "Sign off", exact: true })
          .press("Enter");
        await expect(
          card.getByText("Signed off", { exact: true }).first(),
        ).toBeVisible();
        const replay = await reviewPage.request.post(
          `/api/studio/outputs/${outputId}`,
          { data: { action: "sign_off", ...pin } },
        );
        expect(replay.status()).toBe(200);
        expect(await replay.json()).toMatchObject({
          replayed: true,
          version: version.revision,
          status: "signed_off",
        });
        const back = reviewPage.getByRole("link", {
          name: "Back to inbox",
          exact: true,
        });
        await back.focus();
        await back.press("Enter");
        await expect(reviewPage).toHaveURL(
          new URL("/studio/inbox", baseURL).href,
        );
        await expect(reviewPage.locator(`a[href="${pinnedUrl}"]`)).toHaveCount(
          0,
        );
        await reviewPage.reload();
        await expect(reviewPage.locator(`a[href="${pinnedUrl}"]`)).toHaveCount(
          0,
        );
        await reviewPage
          .context()
          .addCookies([{ name: "locale", value: "zh-Hant", url: baseURL }]);
        await reviewPage.goto(pinnedUrl);
        await expect(
          reviewPage.getByText("已簽核", { exact: true }).first(),
        ).toBeVisible();
        await expect(
          reviewPage.getByRole("link", { name: "返回收件匣", exact: true }),
        ).toBeVisible();
        expect(
          await reviewPage
            .locator('[data-proposal-row="true"] td')
            .evaluateAll((cells) =>
              cells.every((cell) => cell.getBoundingClientRect().width >= 250),
            ),
        ).toBe(true);
        expect(
          await reviewPage
            .locator('[data-proposal-row="true"] code')
            .first()
            .evaluate((code) => code.getClientRects().length),
        ).toBe(1);
        expect(
          await reviewPage.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await reviewPage.screenshot({
          path: "node_modules/.studio-evidence/studio-reviewer-confirmed-390-zh.png",
          fullPage: true,
        });
      }
      expect(reviewMessagePosts).toBe(0);
      expect(messagePosts).toBe(3);
    }
    await journey
      .getByRole("button", { name: "Refresh journey status", exact: true })
      .click();
    const handoff = journey.getByRole("link", {
      name: "Open pinned listing review",
      exact: true,
    });
    await expect(handoff).toBeVisible();
    expect(await handoff.getAttribute("href")).toMatch(
      /studioOutput=.*&studioRevision=1&studioDigest=[a-f0-9]{64}$/,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("guided-journey-390.png"),
      fullPage: true,
    });
    // A separate explicitly submitted request cannot overdraw the cumulative cap.
    const ceiling = run.reservedUsd;
    expect(Number(ceiling)).toBeGreaterThan(0);
    expect(
      (
        await page.request.patch("/api/studio/settings", {
          data: {
            ...configured,
            monthlyBudgetUsd: ceiling,
            runCeilingUsd: ceiling,
          },
        })
      ).status(),
    ).toBe(200);
    const blocked = await page.request.post(
      `/api/studio/threads/${copy.threadId}/messages`,
      {
        data: {
          clientMessageId: `budget-${Date.now()}`,
          text: "Explicit budget-boundary attempt",
          locale: "en",
          guidedAction: {
            kind: "copy_proposal",
            sourceOutputId: gapId,
            sourceRevision: gapVersion.revision,
            sourceDigest: gapVersion.contentDigest,
          },
        },
      },
    );
    expect(blocked.status()).toBe(200);
    const blockedBody = await blocked.json();
    expect(blockedBody.reply.outputs).toHaveLength(0);
    const blockedRun = await readRun(page, copy.threadId, blockedBody.runId);
    expect(blockedRun.model).toBeNull();
    const after = await (await page.request.get(`/api/listings/${ID}`)).json();
    expect(after.activeVersion).toEqual(before.activeVersion);
    expect(after.status).toBe(before.status);
    await handoff.click();
    await expect(page.locator('[data-studio-handoff="true"]')).toContainText(
      "Acceptance copy proposed for human review.",
    );
    await page
      .context()
      .addCookies([{ name: "locale", value: "zh-Hant", url: baseURL }]);
    await page.goto(`/studio/t/${copy.threadId}`);
    await expect(page.locator('[data-guided-journey="true"]')).toContainText(
      "改善這個商品",
    );
  } finally {
    expect(
      (
        await page.request.patch("/api/studio/settings", { data: original })
      ).status(),
    ).toBe(200);
    for (const context of reviewContexts) await context.close();
  }
});

test("guided entry is hidden for a readonly member", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing fixture URL");
  await signIn(page, baseURL, true);
  await page.goto(`/listings/${ID}`);
  await expect(
    page.getByRole("link", { name: "Start guided review", exact: true }),
  ).toHaveCount(0);
});
