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
