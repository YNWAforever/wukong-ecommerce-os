import { test, expect } from "@playwright/test";
import { writeFile, mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  signQueueRequest,
  LISTING_INGRESS_PATH,
} from "../../packages/jobs/src/index.js";
import {
  prepareWineStackFixture,
  enrollAndSignInOpakAdmin,
  wineLabelPng,
  verifyUploadedAsset,
  readWineRuntimeEvidence,
} from "./real-stack-fixture.js";

test.describe.configure({ mode: "default" });
test.use({ trace: "on" });
let testStartedAt: string;
test.beforeEach(() => {
  testStartedAt = new Date().toISOString();
});
test.afterEach(async ({ page }, info) => {
  if (process.env.WUKONG_WINE_E2E !== "1") return;
  const provider = await fetch("http://127.0.0.1:49221/evidence").then((r) =>
    r.json(),
  );
  await writeFile(
    info.outputPath("provider-evidence.json"),
    JSON.stringify(provider, null, 2),
  );
  const listingId = page.url().match(/\/listings\/([0-9a-f-]{36})/)?.[1];
  if (listingId) {
    const response = await page.request.get(`/api/listings/${listingId}`);
    if (response.ok())
      await writeFile(
        info.outputPath("final-view.json"),
        JSON.stringify(
          await response.json(),
          (_key, value) =>
            typeof value === "string" && value.includes("X-Amz-")
              ? value.split("?")[0]
              : value,
          2,
        ),
      );
  }
  const stable = resolve(
    ".wrangler/wine-sdd/task13b-artifacts",
    info.title.replace(/[^a-zA-Z0-9]+/g, "-"),
  );
  await writeFile(
    info.outputPath("acceptance-status.json"),
    JSON.stringify(
      {
        title: info.title,
        status: info.status,
        startTime: testStartedAt,
        evidenceCapturedAt: new Date().toISOString(),
        componentSha: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
          windowsHide: true,
        }).trim(),
        workingTreeChanges: Boolean(
          execFileSync("git", ["status", "--porcelain"], {
            encoding: "utf8",
            windowsHide: true,
          }).trim(),
        ),
        syntheticOnly: true,
        physicalCallCounts: provider.calls.reduce(
          (counts: Record<string, number>, call: { kind: string }) => ({
            ...counts,
            [call.kind]: (counts[call.kind] ?? 0) + 1,
          }),
          {},
        ),
      },
      null,
      2,
    ),
  );
  await mkdir(stable, { recursive: true });
  await cp(info.outputDir, stable, { recursive: true });
});
test("synthetic wine upload persists through real Web, S3 and Queue", async ({
  page,
}, info) => {
  test.skip(
    process.env.WUKONG_WINE_E2E !== "1",
    "Explicit local wine stack required",
  );
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = await prepareWineStackFixture();
  await fetch("http://127.0.0.1:49221/control", {
    method: "POST",
    body: JSON.stringify({ scenario: "exact" }),
  });
  await enrollAndSignInOpakAdmin(page);
  await page.locator("#listing-files").setInputFiles([
    {
      name: "synthetic-wine-label.png",
      mimeType: "image/png",
      buffer: await wineLabelPng(),
    },
    {
      name: "synthetic-wine-back.png",
      mimeType: "image/png",
      buffer: await wineLabelPng(2020, "Back"),
    },
  ]);
  await expect(page.locator(".file-row strong")).toHaveText([
    "synthetic-wine-label.png",
    "synthetic-wine-back.png",
  ]);
  const uploads: string[] = [];
  const successfulUploads: string[] = [];
  page.on("response", (response) => {
    if (
      response.request().method() === "PUT" &&
      new URL(response.url()).origin === "https://localhost:9012" &&
      response.ok()
    )
      successfulUploads.push(new URL(response.url()).pathname);
  });
  let rejectSecond = true;
  await page.route("https://localhost:9012/**", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const path = new URL(route.request().url()).pathname;
    uploads.push(path);
    if (rejectSecond && path.includes("synthetic-wine-back.png"))
      return route.abort("connectionreset");
    return route.continue();
  });
  const failedUpload = page.waitForEvent(
    "requestfailed",
    (request) => request.method() === "PUT",
  );
  await page.getByRole("button", { name: /Create listing draft/ }).click();
  await failedUpload;
  await expect(
    page.getByRole("button", { name: /Create listing draft/ }),
  ).toBeEnabled();
  await expect(page).toHaveURL(/\/listings\/new$/);
  expect(
    uploads.filter((path) => path.includes("synthetic-wine-label.png")),
  ).toHaveLength(1);
  rejectSecond = false;
  await page.screenshot({
    path: info.outputPath("wine-upload-en.png"),
    fullPage: true,
  });
  const intake = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/listings" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Create listing draft/ }).click();
  const result = await intake;
  expect(result.ok(), await result.text()).toBe(true);
  await expect(page).toHaveURL(/\/listings\/[0-9a-f-]{36}/);
  const listingId = page.url().match(/\/listings\/([0-9a-f-]{36})/)![1]!;
  await verifyUploadedAsset(listingId);
  expect(new Set(successfulUploads).size).toBe(2);
  expect(
    uploads.filter((path) => path.includes("synthetic-wine-label.png")),
  ).toHaveLength(1);
  expect(
    uploads.filter((path) => path.includes("synthetic-wine-back.png")).length,
  ).toBeGreaterThanOrEqual(2);
  await expect(
    page.getByRole("heading", { name: "Wine enrichment", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("wine-progress-en.png"),
    fullPage: true,
  });
  await page.goto("/listings");
  await page.goto(`/listings/${listingId}`);
  await expect(
    page.getByRole("heading", { name: "Bilingual sections" }),
  ).toBeVisible({ timeout: 60000 });
  await expect(page.getByLabel(/Introduction.*English/)).toHaveValue(
    "Presented in a 750 ml bottle.",
    { timeout: 60000 },
  );
  await page.screenshot({
    path: info.outputPath("wine-review-en.png"),
    fullPage: true,
  });
  const initialRuntime = await readWineRuntimeEvidence(
    fixture.workspaceId,
    listingId,
  );
  expect(initialRuntime.executionState).toBe("succeeded");
  expect(initialRuntime.documents.some((d) => d.state === "completed")).toBe(
    true,
  );
  expect(initialRuntime.budget[0]!.state).toBe("settled");
  const physicalBefore = await fetch("http://127.0.0.1:49221/evidence").then(
    (r) => r.json(),
  );
  const deliveriesBefore = await fetch(
    "http://127.0.0.1:8789/__test/deliveries",
  ).then((r) => r.json());
  const duplicateBody = JSON.stringify({
    schemaVersion: 2,
    flowVersion: "wine-enrichment-v1",
    workspaceId: fixture.workspaceId,
    draftId: listingId,
    runId: initialRuntime.runId,
    inputRevision: 1,
    activeVersionSequence: 0,
    stage: "extraction",
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signQueueRequest({
    secret: "local-e2e-ingress-secret-only-not-for-production-2026",
    timestamp,
    path: LISTING_INGRESS_PATH,
    body: duplicateBody,
  });
  const duplicate = await fetch(
    `http://127.0.0.1:8789${LISTING_INGRESS_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wukong-timestamp": String(timestamp),
        "x-wukong-signature": signature,
      },
      body: duplicateBody,
    },
  );
  expect(duplicate.status).toBe(202);
  await expect
    .poll(
      async () =>
        (
          await fetch("http://127.0.0.1:8789/__test/deliveries").then((r) =>
            r.json(),
          )
        ).length,
    )
    .toBe(deliveriesBefore.length + 1);
  expect(
    await fetch("http://127.0.0.1:49221/evidence").then((r) => r.json()),
  ).toEqual(physicalBefore);
  const verified = initialRuntime.stages.find(
    (s) => s.stage === "verification",
  )!.output.result.frozenVerification;
  const webSources = verified.sources.filter(
    (s: { kind: string }) => s.kind === "web",
  );
  expect(webSources.length).toBeGreaterThan(0);
  expect(
    webSources.every(
      (s: {
        identity: { producer: string; vintage: { year: number } };
        trust: string;
      }) =>
        s.identity?.producer === "Fixture Estate" &&
        s.identity?.vintage.year === 2020 &&
        s.trust === "verified_official",
    ),
  ).toBe(true);
  expect(
    verified.supports.some(
      (s: { sourceId: string; field: string }) =>
        webSources.some((w: { id: string }) => w.id === s.sourceId) &&
        s.field === "volumeMl",
    ),
  ).toBe(true);
  const verifiedClaims = initialRuntime.stages.find(
    (s) => s.stage === "verification",
  )!.output.result.claims;
  expect(
    verifiedClaims.some(
      (c: { state: string; field: string; evidenceIds: string[] }) =>
        c.state === "accepted" &&
        c.field === "volumeMl" &&
        c.evidenceIds.some((id) =>
          webSources.some((source: { id: string }) => source.id === id),
        ),
    ),
  ).toBe(true);
  await page
    .getByRole("heading", { name: "Bilingual sections" })
    .locator("..")
    .screenshot({ path: info.outputPath("wine-paragraphs-en.png") });
  const intro = page.getByLabel(/Introduction.*English/);
  await intro.fill("Operator paragraph survives history navigation.");
  page.once("dialog", (d) => d.accept());
  await page.goBack();
  await expect(page).toHaveURL(/\/listings$/);
  await page.goForward();
  await expect(intro).toHaveValue(
    "Operator paragraph survives history navigation.",
  );
  page.once("dialog", (d) => d.dismiss());
  await page
    .getByRole("button", { name: "Discard edits and load latest" })
    .click();
  await expect(intro).toHaveValue(
    "Operator paragraph survives history navigation.",
  );
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Discard edits and load latest" })
    .click();
  await expect(intro).toHaveValue("Presented in a 750 ml bottle.");
  await intro.fill("Operator saved introduction.");
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith("/inputs"),
  );
  await page
    .getByRole("button", { name: "Save sections", exact: true })
    .click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator('[data-regenerate="serving"]')).toBeEnabled();
  await page.reload();
  await expect(intro).toHaveValue("Operator saved introduction.");
  const beforeRegeneration = await page.request
    .get(`/api/listings/${listingId}`)
    .then((r) => r.json());
  const proposed = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/regenerate"),
  );
  await page.locator('[data-regenerate="serving"]').click();
  expect((await proposed).status()).toBe(202);
  await expect(
    page.getByRole("heading", { name: "Compare differences before adoption" }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.locator('[data-proposal-path="sections.introduction"]'),
  ).toBeDisabled();
  await page.locator('[data-proposal-path="sections.serving"]').check();
  await page.screenshot({
    path: info.outputPath("wine-evidence-diff-en.png"),
    fullPage: true,
  });
  const adopted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/adopt"),
  );
  await page
    .getByRole("button", { name: "Adopt selected differences" })
    .click();
  expect((await adopted).status()).toBe(200);
  await expect(intro).toHaveValue("Operator saved introduction.");
  await expect(page.getByLabel(/Serving.*English/)).toHaveValue(
    "Bottle capacity: 750 ml.",
  );
  const afterAdoption = await page.request
    .get(`/api/listings/${listingId}`)
    .then((r) => r.json());
  expect(afterAdoption.activeVersion.id).not.toBe(
    beforeRegeneration.activeVersion.id,
  );
  const manualVersion = await page.request.put(
    `/api/listings/${listingId}/review`,
    {
      data: {
        baseVersionId: afterAdoption.activeVersion.id,
        expectedInputRevision: afterAdoption.inputRevision,
        content: {
          ...afterAdoption.activeVersion.content,
          sku: "OPERATOR-LOCAL-13B",
        },
      },
    },
  );
  expect(manualVersion.status(), await manualVersion.text()).toBe(200);
  const current = await page.request
    .get(`/api/listings/${listingId}`)
    .then((r) => r.json());
  expect(current.activeVersion.id).not.toBe(afterAdoption.activeVersion.id);
  expect(current.wineProgress.adoptedVersionId).toBe(
    afterAdoption.activeVersion.id,
  );
  await page
    .context()
    .addCookies([
      { name: "locale", value: "zh-Hant", url: "http://127.0.0.1:49217" },
    ]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "雙語段落" })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("wine-review-zh-Hant.png"),
    fullPage: true,
  });
  expect(
    (
      await page.request.get(`/api/listings/${fixture.foreignListingId}`)
    ).status(),
  ).toBe(404);
  const evidence = await fetch("http://127.0.0.1:49221/evidence").then((r) =>
    r.json(),
  );
  expect(
    evidence.calls.filter((c: { kind: string }) => c.kind === "fixture_error"),
  ).toEqual([]);
  expect(
    evidence.calls.some(
      (c: { snapshotVerified?: boolean }) => c.snapshotVerified,
    ),
  ).toBe(true);
  expect(
    evidence.calls.filter((c: { kind: string }) => c.kind === "generation"),
  ).toHaveLength(2);
  const runtime = await readWineRuntimeEvidence(fixture.workspaceId, listingId);
  expect(runtime.executionState).toBe("succeeded");
  expect(runtime.search).toHaveLength(0);
  await writeFile(
    info.outputPath("runtime-evidence.json"),
    JSON.stringify(
      {
        syntheticOnly: true,
        ...fixture,
        listingId,
        uploads,
        successfulUploads,
        duplicateDelivery: {
          before: deliveriesBefore.length,
          after: deliveriesBefore.length + 1,
          physicalCallsUnchanged: true,
        },
        adoptedVersionId: afterAdoption.activeVersion.id,
        currentVersionId: current.activeVersion.id,
        initialRuntime,
        runtime,
        ...evidence,
      },
      null,
      2,
    ),
  );
});

for (const scenario of [
  "ambiguous",
  "conflict",
  "empty",
  "transport_unknown",
  "injection",
] as const) {
  test(`actual synthetic HTTP journey: ${scenario}`, async ({ page }, info) => {
    test.skip(
      process.env.WUKONG_WINE_E2E !== "1",
      "Explicit local wine stack required",
    );
    test.setTimeout(180000);
    page.setDefaultTimeout(15000);
    const fixture = await prepareWineStackFixture();
    await fetch("http://127.0.0.1:49221/control", {
      method: "POST",
      body: JSON.stringify({ scenario }),
    });
    await enrollAndSignInOpakAdmin(page);
    await page.locator("#listing-files").setInputFiles({
      name: `synthetic-${scenario}.png`,
      mimeType: "image/png",
      buffer: await wineLabelPng(scenario === "ambiguous" ? null : 2020),
    });
    await page.getByRole("button", { name: /Create listing draft/ }).click();
    await expect(page).toHaveURL(/\/listings\/[0-9a-f-]{36}/);
    const listingId = page.url().match(/\/listings\/([0-9a-f-]{36})/)![1]!;
    let view: any;
    await expect
      .poll(
        async () => {
          view = await page.request
            .get(`/api/listings/${listingId}`)
            .then((r) => r.json());
          return view.currentRun?.state;
        },
        { timeout: 60000 },
      )
      .toBe(scenario === "transport_unknown" ? "failed" : "succeeded");
    await page.reload();
    const initialRuntime = await readWineRuntimeEvidence(
      fixture.workspaceId,
      listingId,
    );
    if (scenario === "empty") {
      expect(view.wineProgress.enrichment).toBe("partial");
      expect(
        view.wineProgress.evidence.every(
          (e: { kind: string }) => e.kind === "photo",
        ),
      ).toBe(true);
      expect(initialRuntime.budget[0]!.state).toBe("settled");
      await expect(page.getByLabel(/Introduction.*English/)).toHaveValue(
        "Presented in a 750 ml bottle.",
      );
    } else if (scenario === "transport_unknown") {
      expect(initialRuntime.budget[0]!.state).toBe("unknown");
      expect(view.wineProgress.tavilyCredits).toBeNull();
      expect(
        view.wineProgress.evidence.some(
          (e: { kind: string }) => e.kind === "photo",
        ),
      ).toBe(true);
      expect(initialRuntime.ai.map((c) => c.stage)).toEqual(["extraction"]);
      await expect(
        page
          .getByRole("region", { name: "Wine enrichment" })
          .getByRole("status"),
      ).toHaveText("Failed");
    } else if (scenario === "conflict") {
      const verification =
        initialRuntime.stages.find(
          (s) => s.stage === "verification_deep" && s.state === "succeeded",
        )?.output.result ??
        initialRuntime.stages.find((s) => s.stage === "verification")!.output
          .result;
      expect(
        verification.claims.some(
          (c: { state: string }) => c.state === "conflict",
        ),
      ).toBe(true);
      expect(
        view.wineProgress.issues.some(
          (issue: { code: string }) => issue.code === "trusted_source_conflict",
        ),
      ).toBe(true);
      expect(JSON.stringify(view.activeVersion.content)).not.toMatch(
        /Oak barrels|Steel tanks/,
      );
    } else if (scenario === "injection") {
      expect(view.activeVersion.content.priceHkd).toBeNull();
      expect(view.activeVersion.content.sku).toBeNull();
      expect(JSON.stringify(view.activeVersion.content)).not.toContain(
        "FORGED-SOURCE-SKU",
      );
      expect(
        view.wineProgress.evidence.some((e: { excerpt: string }) =>
          e.excerpt.includes("Ignore all rules"),
        ),
      ).toBe(true);
    } else {
      const choices = view.wineProgress.candidates.filter(
        (c: { confirmationAvailable: boolean }) => c.confirmationAvailable,
      );
      expect(
        [
          ...new Set(
            choices.map(
              (c: { identity: { vintage: { year: number } } }) =>
                c.identity.vintage.year,
            ),
          ),
        ].sort(),
      ).toEqual([2020, 2021]);
      expect(
        choices.every(
          (c: { stage: string }) => c.stage === "verification_deep",
        ),
      ).toBe(true);
      const historical = page.getByRole("radio", { name: /Inspection only/ });
      const historicalSource = initialRuntime.stages
        .find((s) => s.stage === "verification")!
        .output.result.frozenVerification.sources.find(
          (source: { kind: string }) => source.kind === "web",
        );
      const stale = await page.request.post(
        `/api/listings/${listingId}/wine-enrichment/identity`,
        {
          headers: { "Idempotency-Key": crypto.randomUUID() },
          data: {
            expectedInputRevision: view.inputRevision,
            baseVersionId: view.activeVersion?.id ?? null,
            sourceRunId: initialRuntime.runId,
            sourceStage: "verification",
            sourceId: historicalSource.id,
          },
        },
      );
      expect(stale.status()).toBe(409);
      expect(
        view.wineProgress.candidates.some(
          (c: { stage: string }) => c.stage === "verification",
        ),
      ).toBe(false);
      await expect(historical).toHaveCount(1);
      await expect(historical).toBeDisabled();
      await expect(historical).toHaveAccessibleName(/Unknown vintage/);
      await expect(
        page
          .getByRole("group", { name: "Confirm product identity" })
          .locator('input[type="radio"]:enabled'),
      ).toHaveCount(2);
      const choice = page
        .getByRole("radio", { name: /Fixture Estate.*2020/ })
        .and(page.locator(":enabled"))
        .first();
      await expect(choice).toBeEnabled();
      await choice.focus();
      await page.keyboard.press("Space");
      await expect(choice).toBeChecked();
      await page
        .getByRole("group", { name: "Confirm product identity" })
        .screenshot({ path: info.outputPath("wine-ambiguity-en.png") });
      const confirmed = page.waitForResponse(
        (r) => r.request().method() === "POST" && r.url().endsWith("/identity"),
      );
      await page
        .getByRole("button", { name: "Confirm selected identity" })
        .click();
      expect((await confirmed).status()).toBe(202);
      await expect
        .poll(
          async () => {
            view = await page.request
              .get(`/api/listings/${listingId}`)
              .then((r) => r.json());
            return (
              view.currentRun?.runId !== initialRuntime.runId &&
              view.currentRun?.state === "succeeded"
            );
          },
          { timeout: 60000 },
        )
        .toBe(true);
      expect(view.inputRevision).toBe(initialRuntime.inputRevision + 1);
      expect(view.wineProgress.identity).toMatchObject({
        status: "matched",
        vintage: { state: "known", year: 2020 },
      });
    }
    const runtime = await readWineRuntimeEvidence(
      fixture.workspaceId,
      listingId,
    );
    const provider = await fetch("http://127.0.0.1:49221/evidence").then((r) =>
      r.json(),
    );
    expect(
      provider.calls.filter(
        (c: { kind: string }) => c.kind === "fixture_error",
      ),
    ).toEqual([]);
    await writeFile(
      info.outputPath("runtime-evidence.json"),
      JSON.stringify(
        {
          syntheticOnly: true,
          scenario,
          ...fixture,
          listingId,
          initialRuntime,
          runtime,
          provider,
        },
        null,
        2,
      ),
    );
    await page
      .getByRole("region", { name: "Wine enrichment" })
      .screenshot({ path: info.outputPath(`wine-${scenario}-en.png`) });
  });
}

test("manual input edit during actual HTTP extraction supersedes stale work", async ({
  page,
}, info) => {
  test.skip(
    process.env.WUKONG_WINE_E2E !== "1",
    "Explicit local wine stack required",
  );
  test.setTimeout(90000);
  const fixture = await prepareWineStackFixture();
  await fetch("http://127.0.0.1:49221/control", {
    method: "POST",
    body: JSON.stringify({ scenario: "midrun_edit" }),
  });
  await enrollAndSignInOpakAdmin(page);
  await page.locator("#listing-files").setInputFiles({
    name: "synthetic-midrun.png",
    mimeType: "image/png",
    buffer: await wineLabelPng(),
  });
  await page.getByRole("button", { name: /Create listing draft/ }).click();
  await expect(page).toHaveURL(/\/listings\/[0-9a-f-]{36}/);
  const listingId = page.url().match(/\/listings\/([0-9a-f-]{36})/)![1]!;
  try {
    await expect
      .poll(async () =>
        (
          await fetch("http://127.0.0.1:49221/evidence").then((r) => r.json())
        ).calls.some((c: { kind: string }) => c.kind === "extraction"),
      )
      .toBe(true);
    const before = await page.request
      .get(`/api/listings/${listingId}`)
      .then((r) => r.json());
    const saved = await page.request.patch(
      `/api/listings/${listingId}/inputs`,
      {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        data: {
          expectedInputRevision: before.inputRevision,
          baseVersionId: before.activeVersion?.id ?? null,
          note: "Operator mid-run correction remains authoritative.",
          action: "save",
        },
      },
    );
    expect(saved.status(), await saved.text()).toBe(200);
  } finally {
    await fetch("http://127.0.0.1:49221/release", { method: "POST" });
  }
  await expect
    .poll(
      async () =>
        (await readWineRuntimeEvidence(fixture.workspaceId, listingId))
          .executionState,
    )
    .toBe("superseded");
  const view = await page.request
    .get(`/api/listings/${listingId}`)
    .then((r) => r.json());
  expect(JSON.stringify(view)).toContain(
    "Operator mid-run correction remains authoritative.",
  );
  expect(view.activeVersion).toBeNull();
  const runtime = await readWineRuntimeEvidence(fixture.workspaceId, listingId);
  await writeFile(
    info.outputPath("runtime-evidence.json"),
    JSON.stringify(
      { syntheticOnly: true, ...fixture, listingId, runtime },
      null,
      2,
    ),
  );
});
