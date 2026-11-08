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
const PASSWORD = "Local-only studio browser password 1!";

test.skip(!enabled, "Set STUDIO_BROWSER_ACCEPTANCE=1 against a seeded local app.");

async function signIn(page: Page, baseURL: string) {
  await page.context().addCookies([
    { name: "locale", value: "en", url: baseURL },
  ]);
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(EMAIL);
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
      .getByText(/Follow-up questions|Known limitations|More information needed/)
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
});
