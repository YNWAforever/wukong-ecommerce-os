import { expect, type Browser } from "@playwright/test";

/** Exercise the real server-rendered form before any submit handler exists. */
export async function assertNativeCredentialsInBody(
  browser: Browser,
  baseURL: string,
  entryURL = "/signin",
) {
  const origin = new URL(baseURL).origin;
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    await context.addCookies([{ name: "locale", value: "en", url: origin }]);
    const page = await context.newPage();
    await page.route("**/signin*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin === origin &&
        request.isNavigationRequest() &&
        (request.postData() !== null || url.searchParams.has("email"))
      ) {
        // Observe native navigation without sending any auth/provider request.
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<p>Synthetic native submission captured</p>",
        });
      } else await route.continue();
    });
    await page.goto(entryURL);
    await page.getByLabel("Email address").fill("native-submit@local.invalid");
    const password = "synthetic-native-submit-check";
    await page.getByLabel("Password", { exact: true }).fill(password);
    const submitted = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.origin === origin &&
        url.pathname === "/signin" &&
        request.isNavigationRequest() &&
        (request.postData() !== null || url.searchParams.has("email"))
      );
    });
    await page.getByRole("button", { name: "Sign in with password" }).click();
    const request = await submitted;
    // Failure diagnostics contain only booleans/method, never submitted values.
    expect(request.method()).toBe("POST");
    const url = new URL(request.url());
    expect(url.searchParams.has("password")).toBe(false);
    expect(url.searchParams.has("email")).toBe(false);
    const body = new URLSearchParams(request.postData() ?? "");
    expect(body.get("password") === password).toBe(true);
    expect(body.get("email") === "native-submit@local.invalid").toBe(true);
  } finally {
    await context.close();
  }
}
