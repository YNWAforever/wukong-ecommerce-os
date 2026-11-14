import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Flags-on Conversation Studio browser acceptance (plan Task 14).
 *
 * Gated on `STUDIO_BROWSER_ACCEPTANCE=1` and `PLAYWRIGHT_BASE_URL` pointing at a
 * local app whose database was seeded with the matching owner account and an
 * enabled `studio_workspace_settings` row. It drives the real deterministic
 * flow: password sign-in, Studio home, send a records question, engine/evidence
 * render, thread persistence after reload, and the 390 px layout.
 *
 * It never calls a model provider, MCP server or SHOPLINE: the AI flag is off.
 */

const enabled = process.env.STUDIO_BROWSER_ACCEPTANCE === "1";
const EMAIL = "studio-browser-e2e@local.invalid";
const VIEWER_EMAIL = "studio-browser-viewer@local.invalid";
const PASSWORD = "Local-only studio browser password 1!";
/** Duplicated from the seed module (export values must not run in Playwright). */
const SUPPLIER_LISTING_ID = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a01";
const HANDOFF_OUTPUT_ID = "6c27b9d3-2a4a-4b6b-9e9e-2f0f0b6f7a06";

test.skip(
  !enabled,
  "Set STUDIO_BROWSER_ACCEPTANCE=1 against a seeded local app.",
);

async function signIn(page: Page, baseURL: string, email = EMAIL) {
  await page
    .context()
    .addCookies([{ name: "locale", value: "en", url: baseURL }]);
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), {
    timeout: 30_000,
  });
}

test("zero-result catalog search shows the executed query and refines without sending", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await signIn(page, baseURL ?? "http://127.0.0.1:49300");
  await page.goto("/studio");
  const query = "studio-no-matching-sku-7f6e2a";
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(query);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/studio\/t\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  await expect(
    page.getByText(`Search used: “${query}”.`, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(
      "No linked listing records matched this search. Try a shorter product name or SKU, then send the search again.",
      { exact: true },
    ),
  ).toBeVisible();
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/studio/"))
      posts++;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const refine = page.getByRole("button", {
    name: "Refine search",
    exact: true,
  });
  await refine.click();
  await expect(composer).toHaveValue(query);
  await expect(composer).toBeFocused();
  expect(posts).toBe(0);
  await composer.fill("Keep this unsent draft");
  await expect(refine).toBeDisabled();
  await expect(composer).toHaveValue("Keep this unsent draft");
  await page.screenshot({
    path: "test-results/studio-zero-refinement-390.png",
    fullPage: true,
  });
});

test("flags-on studio: sign in, deterministic answer, trace, reload persistence, 390px", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  await signIn(page, origin);

  // The Studio is enabled: home renders instead of 404.
  await page.goto("/studio");
  await expect(page.getByText("Start a conversation")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Welcome back")).toBeVisible();
  await expect(page.getByText("STUDIO", { exact: true }).first()).toBeVisible();

  // Send a deterministic records question; no model flag is on.
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("margaux");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/studio\/t\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  const threadUrl = page.url();

  await expect(page.getByText("Your message")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("margaux").first()).toBeVisible();
  // The deterministic reply renders its records checks and follow-ups (or an
  // explicit limitations block when a source is missing).
  await expect(
    page
      .getByText(
        /Follow-up questions|Known limitations|More information needed/,
      )
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  // Execution trace is real and loadable.
  const traceToggle = page.getByText("Execution trace").first();
  await traceToggle.scrollIntoViewIfNeeded();
  await expect(traceToggle).toBeVisible({ timeout: 30_000 });
  await traceToggle.click();
  await expect(page.getByText("Execution trace").first()).toBeVisible();

  // Reload restores the persisted thread from the database.
  await page.reload();
  await expect(page.getByText("Your message", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("margaux").first()).toBeVisible();
  expect(page.url()).toBe(threadUrl);

  // 390px has no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText("Execution trace").first().click();
  await page.getByText("Run details and cost", { exact: true }).click();
  const runDetails = page
    .locator("details")
    .filter({ has: page.getByText("Run details and cost", { exact: true }) })
    .last();
  await expect(
    runDetails.getByText("No budget reservation", { exact: true }),
  ).toBeVisible();
  await expect(
    runDetails
      .getByText("Model provider", { exact: true })
      .locator("..")
      .locator("dd"),
  ).toHaveText("Not recorded");
  await expect(
    runDetails
      .getByText("Recorded cost (USD)", { exact: true })
      .locator("..")
      .locator("dd"),
  ).toHaveText("Not recorded");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: "test-results/studio-browser-acceptance-390.png",
    fullPage: true,
  });

  // The conversation also appears in the threads list.
  await page.goto("/studio/threads");
  await expect(page.locator('a[href^="/studio/t/"]').first()).toBeVisible({
    timeout: 30_000,
  });
  // The orchestration inbox aggregates the same workspace records: the
  // conversation we just created must appear there, and the section labels
  // must render from real reads.
  await page.goto("/studio/inbox");
  await expect(
    page.getByRole("heading", { name: "Orchestration inbox" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Needs attention").first()).toBeVisible();
  await expect(page.getByText("Recent pipeline jobs").first()).toBeVisible();
  await expect(
    page.getByText("Artifacts needing action").first(),
  ).toBeVisible();
  await expect(page.getByText("Recent conversations").first()).toBeVisible();
  await expect(
    page.locator(`a[href="${new URL(threadUrl).pathname}"]`).first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({
    path: "test-results/studio-inbox-acceptance.png",
    fullPage: true,
  });
});

/**
 * Supplier-intel acceptance (C1 v1.1). Mirrors the seed's linked workbook row:
 * the deterministic finding must quote the stored cells, list the unknown ones,
 * state its boundaries, render read-only and survive a reload. No model is
 * configured, so any provider call would fail the turn.
 */
test("flags-on studio: supplier intel finding renders read-only and persists", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  // Must match STUDIO_BROWSER_ACCEPTANCE_SUPPLIER_LISTING_ID in the seed.
  const listingId = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a01";
  await signIn(page, origin);

  await page.goto("/studio");
  await expect(page.getByText("Start a conversation")).toBeVisible({
    timeout: 30_000,
  });

  // The supplier template is pilot-interactive through the registry.
  const supplierCard = page
    .getByRole("listitem")
    .filter({ hasText: "Supplier intel" });
  await expect(supplierCard).toHaveAttribute("data-interactive", "true");
  await supplierCard.getByRole("button", { name: "Fill the composer" }).click();

  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toHaveValue(
    "Compile supplier intel from the linked workbook row: ",
  );
  await composer.fill(
    `Compile supplier intel from the linked workbook row: ${listingId}`,
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/studio\/t\/[0-9a-f-]{36}$/, { timeout: 90_000 });

  const finding = page.locator('[data-finding-kind="supplier_intel"]');
  await expect(finding).toBeVisible({ timeout: 30_000 });
  await expect(finding).toContainText("Supplier intelligence");
  await expect(finding).toContainText("Demo Supplier Ltd");
  await expect(finding).toContainText("Chateau Demo");
  await expect(finding).toContainText("120.0");
  await expect(finding).toContainText("150.0");
  await expect(finding).toContainText("workbook:");
  await expect(finding).toContainText("source_import:");
  await expect(finding).toContainText("Unknown fields: Barcode, MPN");
  await expect(finding).toContainText(
    "Not applied — Studio only saves a read-only finding; no supplier or listing record is written.",
  );
  await expect(finding).toContainText(`Listing ${listingId}`);
  // Read-only: the finding card offers no button control.
  await expect(finding.getByRole("button")).toHaveCount(0);
  await expect(
    finding.getByRole("link", { name: "Open in the review workspace" }),
  ).toHaveAttribute("href", `/listings/${listingId}`);

  // Reload restores the persisted finding and its quoted values.
  await page.reload();
  await expect(
    page.locator('[data-finding-kind="supplier_intel"]'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-finding-kind="supplier_intel"]'),
  ).toContainText("Demo Supplier Ltd");

  // The persisted artifact is listed on the outputs page with its version.
  await page.goto("/studio/outputs");
  await expect(page.getByText(/Supplier intel/).first()).toBeVisible({
    timeout: 30_000,
  });

  await page.screenshot({
    path: "test-results/studio-supplier-finding-acceptance.png",
    fullPage: true,
  });
});

/**
 * B1 attachment acceptance: the composer uploads a real image through the
 * existing presign → PUT → finalize stack (local S3), rejects an unsupported
 * type before uploading, and the sent turn persists the finalized asset id in
 * the operator message. The fixture file is a 1×1 PNG; no bytes leave local
 * object storage.
 */
test("flags-on studio: composer attachment uploads and persists with the turn", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  await signIn(page, origin);
  await page.goto("/studio");
  await expect(page.getByText("Start a conversation")).toBeVisible({
    timeout: 30_000,
  });

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "acceptance.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  const attachmentList = page.getByRole("list", { name: "Attached files" });
  const uploadedChip = attachmentList.locator('li[data-state="uploaded"]');
  await expect(uploadedChip).toContainText("acceptance.png", {
    timeout: 60_000,
  });
  await expect(uploadedChip.getByRole("status")).toHaveText("Uploaded");

  // An unsupported type is rejected by the shared media policy before any
  // network call; the honest reason is rendered and the file can be removed.
  await fileInput.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an attachable file"),
  });
  const rejectedChip = attachmentList.locator(
    'li[data-state="unsupported_type"]',
  );
  await expect(rejectedChip).toContainText("notes.txt");
  await expect(
    page.getByText("Unsupported file type. Use JPG, PNG, WebP or PDF.", {
      exact: true,
    }),
  ).toBeVisible();
  await rejectedChip
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(rejectedChip).toHaveCount(0);

  // Send with the uploaded attachment and the deterministic records question.
  await page.getByRole("textbox", { name: "Message" }).fill("margaux");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/studio\/t\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  const threadUrl = page.url();
  const threadId = new URL(threadUrl).pathname.split("/").pop()!;

  // The persisted operator message carries exactly the finalized asset id, and
  // the attachment is not left in the composer after a successful send.
  const detail = await page.request.get(
    `${origin}/api/studio/threads/${threadId}`,
  );
  expect(detail.ok()).toBe(true);
  const body = (await detail.json()) as {
    messages: Array<{ role: string; content: Record<string, unknown> }>;
  };
  const operatorMessage = body.messages.find((m) => m.role === "operator");
  expect(operatorMessage).toBeTruthy();
  const attachmentAssetIds = operatorMessage?.content.attachmentAssetIds;
  expect(Array.isArray(attachmentAssetIds)).toBe(true);
  expect(attachmentAssetIds).toHaveLength(1);
  expect(typeof (attachmentAssetIds as unknown[])[0]).toBe("string");
  expect(attachmentAssetIds).not.toContain("acceptance.png");
  await expect(page.getByRole("list", { name: "Attached files" })).toHaveCount(
    0,
  );

  // Reload keeps the turn; the attachment id is part of the persisted content.
  await page.reload();
  await expect(page.getByText("Your message")).toBeVisible({
    timeout: 60_000,
  });
  const reloaded = await page.request.get(
    `${origin}/api/studio/threads/${threadId}`,
  );
  const reloadedBody = (await reloaded.json()) as {
    messages: Array<{ role: string; content: Record<string, unknown> }>;
  };
  const persisted = reloadedBody.messages.find((m) => m.role === "operator");
  expect(persisted?.content.attachmentAssetIds).toEqual(attachmentAssetIds);
});

/**
 * Dispatch acceptance: the only Studio path that creates canonical listing
 * data. An uploaded source must make the draft dispatch ready; the operator
 * reviews and confirms explicitly, the created draft reports the honest queue
 * outcome, and replaying the same asset set returns the same listing instead of
 * creating a duplicate.
 */
test("flags-on studio: confirmed draft-from-sources dispatch creates one listing", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  await signIn(page, origin);
  await page.goto("/studio");
  await expect(page.getByText("Start a conversation")).toBeVisible({
    timeout: 30_000,
  });

  // One real uploaded source asset, exactly as B1 produces it.
  await page.locator('input[type="file"]').setInputFiles({
    name: "dispatch-source.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(
    page.locator('li[data-state="uploaded"]', {
      hasText: "dispatch-source.png",
    }),
  ).toContainText("dispatch-source.png", { timeout: 60_000 });

  // Fill the listing-draft template (it never sends), then note the intent.
  const templateCard = page
    .locator('[data-interactive="true"]')
    .filter({ hasText: "Listing draft" })
    .first();
  await templateCard.getByRole("button", { name: "Fill the composer" }).click();
  const composer = page.getByRole("textbox", { name: "Message" });
  const intent = `${await composer.inputValue()}acceptance dispatch source`;
  await composer.fill(intent);
  await expect(
    page.getByText("listing.draft_from_sources").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/studio\/t\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  const threadId = new URL(page.url()).pathname.split("/").pop()!;

  // The deterministic turn prepares a dispatch; nothing has been created yet.
  const dispatchCard = page.getByRole("region", {
    name: "Create listing draft",
  });
  await expect(dispatchCard).toBeVisible({ timeout: 60_000 });
  await expect(dispatchCard).toContainText("1 source asset(s)");
  const before = (await (
    await page.request.get(`${origin}/api/studio/threads/${threadId}`)
  ).json()) as {
    messages: Array<{ role: string; content: Record<string, unknown> }>;
  };
  const operatorMessage = before.messages.find((m) => m.role === "operator");
  const assetIds = operatorMessage?.content.attachmentAssetIds as
    string[] | undefined;
  expect(assetIds).toHaveLength(1);

  // Explicit confirmation is required; the button opens a review panel.
  await dispatchCard
    .getByRole("button", { name: "Review and confirm", exact: true })
    .click();
  const confirmPanel = dispatchCard.getByRole("group", {
    name: "Confirm create draft",
  });
  await expect(confirmPanel).toBeVisible();
  await confirmPanel
    .getByRole("button", { name: "Confirm create draft", exact: true })
    .click();

  await expect(dispatchCard).toContainText("Listing draft created.", {
    timeout: 60_000,
  });
  await expect(dispatchCard).toContainText(
    /Queued into the existing listing pipeline|The draft exists, but processing has not started/,
  );
  const openListing = dispatchCard.getByRole("link", {
    name: "Open the listing",
    exact: true,
  });
  const listingHref = await openListing.getAttribute("href");
  expect(listingHref).toMatch(/^\/listings\/[0-9a-f-]{36}$/);
  const listingId = listingHref!.split("/").pop()!;

  // The canonical listing really exists and was created from this turn.
  const listing = await page.request.get(`${origin}/api/listings/${listingId}`);
  expect(listing.ok()).toBe(true);

  // Replaying the same source set returns the same listing (no duplicate).
  const replay = await page.request.post(
    `${origin}/api/studio/dispatch/listing-draft`,
    {
      data: {
        threadId,
        assetIds,
        skillKey: "listing.draft_from_sources",
        confirmed: true,
      },
    },
  );
  expect(replay.ok()).toBe(true);
  const replayBody = (await replay.json()) as {
    listingId: string;
    replayed: boolean;
  };
  expect(replayBody.listingId).toBe(listingId);
  expect(replayBody.replayed).toBe(true);

  // The created draft opens in the existing review screen.
  await page.goto(`/listings/${listingId}`);
  await expect(page.getByRole("heading").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/server error|This page couldn/)).toHaveCount(0);
});

/**
 * B2 handoff acceptance: a saved copy_proposal artifact renders the read-only
 * banner on the existing listing review page, is dismissible, and fails closed
 * for a foreign or unknown `studioOutput` id. The banner must never apply the
 * proposal; only copy/dismiss actions are allowed.
 */
test("flags-on studio: copy-proposal handoff renders read-only and fails closed", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  await signIn(page, origin);

  // The valid artifact opens the banner above the existing review form.
  await page.goto(
    `/listings/${SUPPLIER_LISTING_ID}?studioOutput=${HANDOFF_OUTPUT_ID}`,
  );
  const banner = page.locator('[data-studio-handoff="true"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toHaveAttribute("data-output-id", HANDOFF_OUTPUT_ID);
  await expect(
    banner.getByRole("heading", { name: "Studio proposal", exact: true }),
  ).toBeVisible();
  await expect(banner.getByText(/not applied/i).first()).toBeVisible();
  await expect(banner.locator('[data-field="title.en"]')).toContainText(
    "Chateau Demo 2020 acceptance proposal",
  );
  await expect(banner.locator('[data-field="description.en"]')).toContainText(
    "A fuller acceptance description proposed by Studio.",
  );

  // Display-only: no apply/save/publish control exists in the banner.
  await expect(
    banner.getByRole("button", { name: /apply|save|publish/i }),
  ).toHaveCount(0);

  // Dismissing drops the query parameter and the banner without any write.
  await banner
    .getByRole("link", { name: "Dismiss proposal", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/listings/${SUPPLIER_LISTING_ID}$`));
  await expect(page.locator('[data-studio-handoff="true"]')).toHaveCount(0);

  // Fail closed: a well-formed but unknown output id renders the page without
  // the banner instead of erroring.
  await page.goto(
    `/listings/${SUPPLIER_LISTING_ID}?studioOutput=11111111-1111-4111-8111-111111111112`,
  );
  await expect(
    page.getByRole("heading", { name: "Studio proposal", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/This page couldn/)).toHaveCount(0);
});

/**
 * B2 export acceptance: the saved copy-proposal artifact exports JSON and PDF
 * through the previewed-digest route. Both downloads are real responses; the
 * JSON receipt is unsigned without a signing key, and stale/missing digests and
 * unknown artifacts fail closed.
 */
test("flags-on studio: saved artifact exports JSON and PDF for the previewed digest", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  await signIn(page, origin);

  await page.goto("/studio/outputs");
  const card = page.locator(`details[data-output-id="${HANDOFF_OUTPUT_ID}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  expect(await card.locator("summary").textContent()).toContain(
    "Copy proposal",
  );
  await card.locator("summary").click();
  await expect(
    card.getByRole("link", { name: "Download JSON", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Copy proposal acceptance")).toBeVisible();
  await expect(card.getByText("Saved", { exact: true }).first()).toBeVisible();

  // The digest the card previewed is the server's current version digest.
  const detailResponse = await page.request.get(
    `${origin}/api/studio/outputs/${HANDOFF_OUTPUT_ID}`,
  );
  expect(detailResponse.ok()).toBe(true);
  const detail = (await detailResponse.json()) as {
    versions: Array<{ revision: number; contentDigest: string }>;
  };
  const latest = detail.versions.reduce((current, version) =>
    version.revision > current.revision ? version : current,
  );

  // JSON export: real download, canonical packet, digest and status intact.
  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download JSON", exact: true }).click(),
  ]);
  expect(jsonDownload.suggestedFilename()).toBe(
    `studio-output-${HANDOFF_OUTPUT_ID}-r${latest.revision}.json`,
  );
  const jsonPath = await jsonDownload.path();
  expect(jsonPath).not.toBeNull();
  const packet = JSON.parse(readFileSync(jsonPath as string, "utf8")) as Record<
    string,
    unknown
  > & {
    output: Record<string, unknown>;
    payload: Record<string, unknown>;
  };
  expect(packet.schemaVersion).toBe("wukong-studio-output-export/v1");
  expect(packet.output.outputId).toBe(HANDOFF_OUTPUT_ID);
  expect(packet.output.kind).toBe("copy_proposal");
  expect(packet.output.status).toBe("saved");
  expect(packet.output.revision).toBe(latest.revision);
  expect(packet.payload.listingId).toBe(SUPPLIER_LISTING_ID);
  expect(packet.payloadSha256).toBe(latest.contentDigest);
  expect(packet.signed).toBe(false);
  expect(packet.receipt).toBeUndefined();

  // PDF export: real download that starts with the PDF magic bytes.
  const [pdfDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download PDF", exact: true }).click(),
  ]);
  expect(pdfDownload.suggestedFilename()).toBe(
    `studio-output-${HANDOFF_OUTPUT_ID}-r${latest.revision}.pdf`,
  );
  const pdfPath = await pdfDownload.path();
  expect(pdfPath).not.toBeNull();
  const pdfBytes = readFileSync(pdfPath as string);
  expect(pdfBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(pdfBytes.byteLength).toBeGreaterThan(1000);

  // Fail closed: a stale digest is refused, a missing digest is a bad request,
  // and an unknown artifact id is the same 404 as any other Studio read.
  const stale = await page.request.get(
    `${origin}/api/studio/outputs/${HANDOFF_OUTPUT_ID}/export?digest=${"a".repeat(64)}`,
  );
  expect(stale.status()).toBe(409);
  const missingDigest = await page.request.get(
    `${origin}/api/studio/outputs/${HANDOFF_OUTPUT_ID}/export`,
  );
  expect(missingDigest.status()).toBe(400);
  const unknown = await page.request.get(
    `${origin}/api/studio/outputs/11111111-1111-4111-8111-111111111112/export?digest=${latest.contentDigest}`,
  );
  expect(unknown.status()).toBe(404);
});

/**
 * Route-level smoke for every Studio surface (A4 hardening). The flags-on spec
 * otherwise exercises only home, one thread, outputs and inbox; a server/client
 * boundary mistake (like the `/studio/outputs` status-chip 500 fixed in #188)
 * can hide in an unvisited page. Each surface must answer with its real heading,
 * and the owner-only settings page must render the A5 usage projection.
 */
test("flags-on studio: every Studio surface renders for an owner", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  await signIn(page, origin);

  const surfaces = [
    { path: "/studio", heading: "Welcome back" },
    { path: "/studio/threads", heading: "Conversations" },
    { path: "/studio/outputs", heading: "Outputs" },
    { path: "/studio/inbox", heading: "Orchestration inbox" },
    { path: "/studio/connections", heading: "Tools and connections" },
    { path: "/studio/settings", heading: "Studio settings" },
  ] as const;
  for (const surface of surfaces) {
    const response = await page.goto(surface.path);
    expect(response?.status(), surface.path).toBeLessThan(400);
    await expect(
      page.getByRole("heading", { name: surface.heading, exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // A Next render error shows its own page instead of the surface heading, but
    // assert the marker directly so a partial page cannot pass silently.
    await expect(page.getByText(/This page couldn/)).toHaveCount(0);
  }

  // A5: the settings page's read-only usage projection renders for the owner.
  await page.goto("/studio/settings");
  await expect(
    page.getByRole("heading", { name: "Usage — last 30 days", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Read-only projection/).first()).toBeVisible();
});

/**
 * Authorization acceptance: a viewer is read-only. The Studio itself is visible
 * to every member once enabled, but creating conversations/sending requires
 * operator or higher, and `/studio/settings` answers 404 to a non-administrator
 * instead of advertising the admin surface. Both are unit-covered; this proves
 * the composed browser behaviour (disabled controls, honest note, 404 boundary).
 */
test("flags-on studio: a viewer is read-only and admin settings stay hidden", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  await signIn(page, origin, VIEWER_EMAIL);

  // Home renders, but the shell and composer are honestly disabled for a reader.
  await page.goto("/studio");
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: "New conversation", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "An operator or higher role is required to create conversations.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Your role can read only; sending requires operator or higher.",
      { exact: false },
    ),
  ).toBeVisible();

  // Every read surface stays available to the viewer.
  const readSurfaces = [
    { path: "/studio/threads", heading: "Conversations" },
    { path: "/studio/outputs", heading: "Outputs" },
    { path: "/studio/inbox", heading: "Orchestration inbox" },
    { path: "/studio/connections", heading: "Tools and connections" },
  ] as const;
  for (const surface of readSurfaces) {
    const response = await page.goto(surface.path);
    expect(response?.status(), surface.path).toBeLessThan(400);
    await expect(
      page.getByRole("heading", { name: surface.heading, exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  }

  // Admin settings are not advertised to a reader: the surface renders the
  // Studio not-found boundary, never the admin form or its data. Next may report
  // HTTP 200 for a streamed not-found response, so assert the rendered boundary
  // and the absence of admin-only content, not just the status code.
  const settings = await page.goto("/studio/settings");
  expect(settings?.status(), "/studio/settings").toBeLessThan(500);
  await expect(
    page.getByRole("heading", { name: "Studio page not found", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Studio settings", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Hosted MCP tokens", { exact: false }),
  ).toHaveCount(0);
});

/**
 * A1 activation-control acceptance: the owner settings form saves through the
 * real `PATCH /api/studio/settings` route and the page then reads the saved
 * values back from the database. Toggling enabled is deliberately avoided
 * (other specs depend on the workspace staying enabled and the CLI activation
 * path is dry-run documented); a budget value and one allowed skill prove the
 * write, validation and readback path. The fixture values are restored before
 * the test ends.
 */
test("flags-on studio: the owner saves workspace settings and reads them back", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  await signIn(page, origin);

  const budget = page.getByLabel("Monthly model budget (USD)");
  const gapSkill = page.getByRole("checkbox", {
    name: /Review approval and export gaps \(catalog\.gap_review\)/,
  });
  const saveButton = page.getByRole("button", {
    name: "Save settings",
    exact: true,
  });

  await page.goto("/studio/settings");
  await expect(budget).toHaveValue("");
  await expect(gapSkill).not.toBeChecked();

  // Write: budget + one allowed skill, then wait for the server readback notice.
  await budget.fill("42.5");
  await gapSkill.check();
  await saveButton.click();
  await expect(
    page.getByText("Saved; the values below are read back from the server.", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 30_000 });

  // Persistence is proven by a fresh server render, not by the client state.
  // The server readback canonicalises money to 6 decimals, which is itself
  // evidence that the value came from the database rather than the draft.
  await page.reload();
  await expect(budget).toHaveValue("42.500000", { timeout: 30_000 });
  await expect(gapSkill).toBeChecked();

  // Restore the seeded shape so this spec leaves the workspace as it found it.
  await budget.fill("");
  await gapSkill.uncheck();
  await saveButton.click();
  await expect(
    page.getByText("Saved; the values below are read back from the server.", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(budget).toHaveValue("");
  await expect(gapSkill).not.toBeChecked();
});

/**
 * B4 hosted-MCP acceptance: the owner mints a workspace token in the admin
 * settings UI, a real MCP client calls the reviewed read tools over
 * `POST /api/mcp` with that token, the per-minute quota rejects the next call,
 * rotation invalidates the old plaintext, and revoke closes the endpoint.
 *
 * Requires `STUDIO_MCP_SERVER_ENABLED=true` on the app under test (the CI step
 * and the local runbook set it). Everything stays read-only: dispatch tools are
 * never advertised and the token is only ever held in the test process.
 */
test("flags-on studio: hosted MCP token is quota-limited, rotatable and revocable", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const origin = baseURL ?? "http://127.0.0.1:49300";
  const listingId = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a01";
  const PROTOCOL_VERSION = "2026-07-28";
  await signIn(page, origin);

  async function mcp(token: string, body: unknown) {
    const response = await page.request.post(`${origin}/api/mcp`, {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      data: body,
    });
    return { status: response.status(), body: await response.json() };
  }

  await page.goto("/studio/settings");
  const tokens = page.locator(
    'section[aria-labelledby="studio-settings-tokens"]',
  );
  await expect(tokens.getByText("API tokens", { exact: true })).toBeVisible();

  // Unique label keeps reruns on a disposable database unambiguous.
  const tokenLabel = `Acceptance MCP token ${Date.now()}`;

  // Create a read-scoped token with the smallest honest per-minute quota.
  await tokens.getByLabel("Label", { exact: true }).fill(tokenLabel);
  await tokens
    .getByLabel("Calls per minute (1–600)", { exact: true })
    .fill("2");
  await tokens
    .getByRole("button", { name: "Create token", exact: true })
    .click();
  const plaintext = tokens.locator("code").first();
  await expect(plaintext).toBeVisible({ timeout: 30_000 });
  const firstToken = (await plaintext.textContent())?.trim() ?? "";
  expect(firstToken.startsWith("wuk_")).toBe(true);

  // A real JSON-RPC client: initialize, list, then call reviewed read tools.
  const init = await mcp(firstToken, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "studio-acceptance", version: "1.0.0" },
    },
  });
  expect(init.status).toBe(200);
  expect(init.body.result.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(init.body.result.serverInfo.name).toBe("wukong-eommerce-studio");

  const list = await mcp(firstToken, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const names: string[] = list.body.result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  expect(names).toContain("catalog.get");
  expect(names).toContain("catalog.search");
  // Dispatch and propose require a scope this token does not have.
  expect(names).not.toContain("listing.create_draft");
  expect(names).not.toContain("listing.propose_copy");
  for (const tool of list.body.result.tools as Array<{
    description: string;
  }>) {
    expect(tool.description).toContain("never writes, approves or publishes");
  }

  const detail = await mcp(firstToken, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "catalog.get", arguments: { listingId } },
  });
  expect(detail.body.result.isError).toBeFalsy();
  const detailText = detail.body.result.content[0].text as string;
  expect(detailText).toContain(listingId);
  expect(detailText).not.toContain(firstToken);

  const search = await mcp(firstToken, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "catalog.search", arguments: { query: "Demo" } },
  });
  expect(search.body.result.isError).toBeFalsy();

  // The third tool call in the minute exceeds quota=2; the server says so.
  const limited = await mcp(firstToken, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "catalog.get", arguments: { listingId } },
  });
  expect(limited.status).toBe(200);
  expect(limited.body.error.code).toBe(-32029);

  // The list never reveals the plaintext again, even after a fresh render.
  await page.reload();
  await expect(tokens.getByText(tokenLabel)).toBeVisible();
  await expect(tokens.locator("code").filter({ hasText: "wuk_" })).toHaveCount(
    0,
  );

  // Rotate through the UI: the old plaintext must stop working immediately.
  const row = tokens.locator("tbody tr").first();
  await row.getByRole("button", { name: "Rotate", exact: true }).click();
  await row
    .getByRole("button", { name: "Confirm rotate", exact: true })
    .click();
  await expect(tokens.locator("code").first()).toContainText("wuk_");
  const secondToken =
    (await tokens.locator("code").first().textContent())?.trim() ?? "";
  expect(secondToken).not.toBe(firstToken);
  expect(secondToken.startsWith("wuk_")).toBe(true);

  const oldAfterRotate = await mcp(firstToken, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/list",
    params: {},
  });
  expect(oldAfterRotate.status).toBe(401);
  const newAfterRotate = await mcp(secondToken, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/list",
    params: {},
  });
  expect(newAfterRotate.status).toBe(200);

  // Revoke the replacement; the endpoint answers 401 from then on.
  const activeRow = tokens.locator("tbody tr").first();
  await activeRow.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(activeRow.getByText("Revoked", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const revokedCall = await mcp(secondToken, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/list",
    params: {},
  });
  expect(revokedCall.status).toBe(401);
});
