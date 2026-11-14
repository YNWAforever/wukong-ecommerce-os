import { expect, test, type Page } from "@playwright/test";

test.skip(
  process.env.STUDIO_GUIDED_ACCEPTANCE !== "1",
  "Requires the isolated loopback-only Studio fake-model fixture.",
);
const ID = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a01";
const PASSWORD = "Local-only studio browser password 1!";
async function signIn(page: Page, baseURL: string, viewer = false) {
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
    const auditRun = await (
      await page.request.get(
        `/api/studio/threads/${audit.threadId}/runs/${audit.runId}`,
      )
    ).json();
    expect(auditRun.run.model).toBeNull();
    await page.reload();
    await expect(
      journey.getByRole("button", { name: "Prepare gap review", exact: true }),
    ).toBeEnabled();
    expect(messagePosts).toBe(1);
    const composer = page.locator("textarea");
    await composer.fill("Keep my unsent draft");
    await expect(
      journey.getByRole("button", { name: "Prepare gap review", exact: true }),
    ).toBeDisabled();
    await expect(composer).toHaveValue("Keep my unsent draft");
    await composer.fill("");
    const prepareGap = journey.getByRole("button", {
      name: "Prepare gap review",
      exact: true,
    });
    await prepareGap.focus();
    await prepareGap.press("Enter");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(
      "Review the recorded gaps for the selected listing version.",
    );
    expect(messagePosts).toBe(1);
    const gap = await send(page);
    await expect(journey).toHaveAttribute("data-guided-stage", "gap_review");
    const gapRun = await (
      await page.request.get(
        `/api/studio/threads/${gap.threadId}/runs/${gap.runId}`,
      )
    ).json();
    expect(gapRun.run.model).toBeNull();
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
    expect(messagePosts).toBe(2);
    const copyPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/studio\/threads\/[^/]+\/messages$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await page.getByRole("button", { name: "Send", exact: true }).dblclick();
    const copyResponse = await copyPromise;
    expect(copyResponse.status()).toBe(200);
    const copy = await copyResponse.json();
    await expect(journey).toHaveAttribute("data-guided-stage", "copy_proposal");
    expect(messagePosts).toBe(3);
    const run = await (
      await page.request.get(
        `/api/studio/threads/${copy.threadId}/runs/${copy.runId}`,
      )
    ).json();
    expect(run.run.model).toBe("fake-studio-guided-acceptance");
    expect(
      run.events.filter((event: { kind: string }) => event.kind === "model"),
    ).toHaveLength(1);
    await page.reload();
    await expect(journey).toContainText("save the exact proposal");
    expect(messagePosts).toBe(3);
    const outputId = copy.reply.outputs[0].outputId;
    const proposal = page.locator(`[data-output-id="${outputId}"]`);
    await proposal
      .getByRole("button", { name: "Save artifact", exact: true })
      .click();
    await expect(proposal).toContainText("Saved");
    await proposal
      .getByRole("button", { name: "Sign off", exact: true })
      .click();
    await expect(
      proposal.getByText("Signed off", { exact: true }).first(),
    ).toBeVisible();
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
    const ceiling = run.run.reservedUsd;
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
    const blockedRun = await (
      await page.request.get(
        `/api/studio/threads/${copy.threadId}/runs/${blockedBody.runId}`,
      )
    ).json();
    expect(blockedRun.run.model).toBeNull();
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
