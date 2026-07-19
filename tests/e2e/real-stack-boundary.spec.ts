import { expect, test } from "@playwright/test";

test.beforeEach(() => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1",
    "Set PLAYWRIGHT_E2E=1 to run the real local-stack acceptance gate.",
  );
});

test("release E2E runs against the real application boundary", async ({
  page,
  request,
}) => {
  const session = await request.get("/api/auth/get-session");
  expect(session.status()).toBe(200);
  expect(await session.json()).toBeNull();

  await page.goto("/signin");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(page.locator("body")).toContainText("Password");
});
