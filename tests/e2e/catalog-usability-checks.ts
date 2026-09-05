import { expect, type Page, type TestInfo } from "@playwright/test";

export async function assertNoHorizontalOverflow(page: Page) {
  const bounds = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll("main *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          className: element.className,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      })
      .filter((rect) => rect.right > window.innerWidth + 1 || rect.left < -1)
      .slice(0, 12),
  }));
  expect
    .soft(bounds.document, JSON.stringify(bounds))
    .toBeLessThanOrEqual(bounds.viewport);
}

export async function assertDrawerKeyboardFlow(page: Page) {
  const trigger = page.getByTestId("drawer-trigger");
  await expect(trigger).toBeVisible();
  const size = await trigger.boundingBox();
  expect(size!.width).toBeGreaterThanOrEqual(24);
  expect(size!.height).toBeGreaterThanOrEqual(24);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByTestId("drawer");
  await expect(drawer).toBeVisible();
  const controls = drawer.locator("a[href], button:not([disabled])");
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(controls.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

export async function assertSkipLink(page: Page) {
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
}

export function localBrowserUrl(baseUrl: string | undefined) {
  if (
    !baseUrl ||
    !["http:", "https:"].includes(new URL(baseUrl).protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname)
  ) {
    throw new Error("Loopback browser URL required");
  }
  return baseUrl;
}

/** Uses existing synthetic approved records; this performs reads and locale changes only. */
export async function captureDeliveryLocaleMatrix(
  page: Page,
  testInfo: TestInfo,
  listingId: string,
  attemptId: string,
) {
  const baseUrl = localBrowserUrl(testInfo.project.use.baseURL);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const locale of ["en", "zh-Hant"] as const) {
    await page
      .context()
      .addCookies([{ name: "locale", value: locale, url: baseUrl }]);
    for (const [size, width] of [
      ["desktop", 1440],
      ["mobile", 375],
    ] as const) {
      await page.setViewportSize({ width, height: 1000 });
      const jobsLoaded = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/jobs" &&
          response.status() === 200,
      );
      await page.goto("/jobs");
      await jobsLoaded;
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(
        page.getByText(attemptId, { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page
          .getByRole("button", {
            name: locale === "en" ? "Record correction" : "記錄更正",
            exact: true,
          })
          .first(),
      ).toBeVisible();
      await expect(
        page
          .getByLabel(locale === "en" ? "Correction reason" : "更正原因", {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await assertSkipLink(page);
      if (size === "mobile") await assertDrawerKeyboardFlow(page);
      await page.screenshot({
        path: testInfo.outputPath("task7-jobs-" + locale + "-" + size + ".png"),
        fullPage: true,
      });
      const detailLoaded = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/listings/" + listingId &&
          response.status() === 200,
      );
      await page.goto("/listings/" + listingId);
      await detailLoaded;
      await expect(
        page.locator("main").getByRole("heading", { level: 1 }),
      ).toBeVisible();
      await expect(page.locator("main")).not.toContainText(
        /Loading listing|正在載入商品/,
      );
      await assertNoHorizontalOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(
          "task7-detail-" + locale + "-" + size + "-viewport.png",
        ),
        fullPage: false,
      });
      await page.screenshot({
        path: testInfo.outputPath(
          "task7-detail-" + locale + "-" + size + ".png",
        ),
        fullPage: true,
      });
      const qualityLoaded = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/quality" &&
          response.status() === 200,
      );
      await page.goto("/quality");
      await qualityLoaded;
      await expect(
        page.getByText(
          locale === "en"
            ? "Observed version approval fraction"
            : "版本觀察批准比例",
          { exact: true },
        ),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(
          "task7-quality-populated-" + locale + "-" + size + ".png",
        ),
        fullPage: true,
      });
    }
  }
}
