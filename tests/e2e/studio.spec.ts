import { expect, test, type Page } from "@playwright/test";

/**
 * Conversation Studio end-to-end expectations (plan Task 7).
 *
 * Two different environments are required, and this checkout can start neither:
 *
 *  - **flags off.** The isolated real stack (`PLAYWRIGHT_E2E=1`) starts its
 *    server without any `CONVERSATION_STUDIO_*` variable, so the Studio nav
 *    item must be absent and `/studio` must answer 404 rather than render a
 *    half-enabled shell.
 *  - **flags on.** A Studio acceptance stack opts in explicitly (`STUDIO_E2E=1`)
 *    and must run with `CONVERSATION_STUDIO_ENABLED=true` plus an enabled
 *    `studio_workspace_settings` row for the fixture workspace. There is no
 *    such fixture in this environment, so the flow test records that exact
 *    reason and skips instead of pretending to pass; it is written out in full
 *    so the acceptance run has a script to execute.
 *
 * Route interception cannot substitute for the flags-on fixture: `/studio` is a
 * server-rendered route whose layout resolves the session, the workspace
 * settings row and the env flags before any client fetch happens, and the
 * flags-off tests need a real authenticated session. The skipped tests are
 * therefore recorded, not faked.
 *
 * The stack fixture is imported lazily, inside the tests that need a database.
 * A checkout without the root `postgres` link cannot even load the fixture
 * module, which would turn "tests are skipped here" into a collection error for
 * every spec that imports it eagerly; skipping must stay a clean skip.
 */

test.describe.configure({ mode: "serial" });

const realStack = process.env.PLAYWRIGHT_E2E === "1";
const studioStack = process.env.STUDIO_E2E === "1";

async function signIn(page: Page) {
  const { prepareBulkImportFixture, signInBulkImportOperator } = await import(
    "./real-stack-fixture.js"
  );
  const fixture = await prepareBulkImportFixture();
  await signInBulkImportOperator(page, fixture, false);
  return fixture;
}

test.describe("studio disabled at the deployment level", () => {
  test.skip(
    !realStack,
    "Requires the isolated real stack (PLAYWRIGHT_E2E=1), whose server is started without CONVERSATION_STUDIO_ENABLED.",
  );

  test("direct /studio answers 404 and no Studio nav item is rendered", async ({
    page,
  }) => {
    await signIn(page);

    const response = await page.goto("/studio");
    expect(response?.status()).toBe(404);
    await expect(page.locator('a[href="/studio"]')).toHaveCount(0);

    await page.goto("/dashboard");
    // The shell is rendered and every existing destination stays; only Studio
    // is absent, and it must not be present anywhere in the top bar.
    await expect(page.locator('a[href="/dashboard"]').first()).toBeVisible();
    await expect(page.locator('a[href="/studio"]')).toHaveCount(0);
  });
});

test.describe("studio enabled for a workspace", () => {
  test.skip(
    !studioStack,
    "No flags-on Studio fixture is available in this environment: the stack must run with STUDIO_E2E=1, CONVERSATION_STUDIO_ENABLED=true and an enabled studio_workspace_settings row for the fixture workspace. Neither env is set, so this flow is recorded rather than faked.",
  );

  test("home -> template fill -> send -> trace -> reload restores the thread, and 390px has no horizontal overflow", async ({
    page,
  }) => {
    const fixture = await signIn(page);
    expect(fixture.workspaceId).toBeTruthy();

    await page.goto("/studio");

    // The deterministic overview states its rule and makes no model call.
    await expect(
      page.getByText("From workspace records; no AI call.", { exact: true }),
    ).toBeVisible();

    // A template fills the composer and does not send.
    await page
      .getByRole("button", { name: "Fill the composer" })
      .first()
      .click();
    const composer = page.getByLabel("Message", { exact: true });
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Find and explain these listings: ");
    await expect(page.getByText("Your message", { exact: true })).toHaveCount(0);

    // First send creates the thread and one persisted turn.
    await composer.fill("Find synthetic listings in this workspace");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/t\/[0-9a-f-]{36}$/);
    await expect(
      page.getByText("From your records", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/Execution trace · \d+ steps/),
    ).toBeVisible();

    // The trace loads its persisted steps when expanded.
    await page.getByText(/Execution trace · \d+ steps/).click();
    await expect(
      page.getByText(/catalog\.search|Search catalog/).first(),
    ).toBeVisible();

    // Reload restores the same persisted thread, not a fabricated local state.
    const threadUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(threadUrl);
    await expect(
      page.getByText("From your records", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Find synthetic listings in this workspace"),
    ).toBeVisible();

    // Mobile: no horizontal overflow at 390px.
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
