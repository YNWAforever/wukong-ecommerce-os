import { expect, test } from "@playwright/test";
import postgres from "postgres";
import {
  ADMIN_URL,
  RUNTIME_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";
function assertIsolated() {
  for (const raw of [ADMIN_URL, RUNTIME_URL]) {
    const url = new URL(raw);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/^\/opak_fixes_/.test(url.pathname)
    )
      throw new Error(
        "Admin browser fixtures require a dedicated loopback Opak database",
      );
  }
}
test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1" || process.env.WUKONG_OPAK_E2E !== "1",
    "Requires explicitly enabled isolated synthetic Opak stack",
  );
  assertIsolated();
  if (/native SPA|unindexed SPA/.test(testInfo.title)) {
    const events: unknown[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("t09-history ")) {
        const event = JSON.parse(message.text().slice(12));
        events.push(event);
        console.log("t09-history", event);
      }
    });
    await page.addInitScript(() => {
      const emit = (event: string, detail: object = {}) => {
        const native = (window as Window & { navigation?: { currentEntry?: { index?: number } } }).navigation;
        console.log("t09-history " + JSON.stringify({ event, path: location.pathname, length: history.length, index: native?.currentEntry?.index ?? null, marker: history.state?.__wukongAdminHistory?.index ?? null, ...detail }));
      };
      emit("document");
      const add = window.addEventListener.bind(window);
      const remove = window.removeEventListener.bind(window);
      window.addEventListener = ((name: string, listener: any, options?: any) => {
        if (name === "popstate" || name === "beforeunload") emit("add-" + name, { capture: options === true || options?.capture === true });
        if (name === "popstate" && options === true) {
          return add(name, (event: PopStateEvent) => { emit("guard-enter", { phase: event.eventPhase }); listener(event); emit("guard-exit"); }, options);
        }
        return add(name, listener, options);
      }) as typeof window.addEventListener;
      window.removeEventListener = ((name: string, listener: any, options?: any) => {
        if (name === "popstate" || name === "beforeunload") emit("remove-" + name, { capture: options === true || options?.capture === true });
        return remove(name, listener, options);
      }) as typeof window.removeEventListener;
      add("popstate", () => emit("capture-pop", { phase: event?.eventPhase }), true);
      add("popstate", () => emit("bubble-pop", { phase: event?.eventPhase }));
      const stop = Event.prototype.stopImmediatePropagation;
      Event.prototype.stopImmediatePropagation = function () {
        if (this.type === "popstate") emit("stopped-pop");
        return stop.call(this);
      };
    });
    testInfo.attachments.push({ name: "history-events", contentType: "application/json", body: Buffer.from(JSON.stringify(events)) });
  }
});
test("admin preserves dirty inputs, compares conflicts, connects safely, and uses keyboard tabs", async ({
  page,
}, testInfo) => {
  const fixture = await prepareBulkImportFixture();
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`update memberships set role='admin' where workspace_id=${fixture.workspaceId} and user_id=${fixture.userId}`;
  } finally {
    await admin.end();
  }
  await signInBulkImportOperator(page, fixture, false);
  await page.goto("/admin");
  await expect(
    page.getByRole("tab", { name: "Members", exact: true }),
  ).toBeVisible();
  const invite = page.getByLabel(/Invite email address/);
  await invite.fill("draft-admin@local.invalid");
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(invite).toHaveValue("draft-admin@local.invalid");
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  const color = page.getByLabel(/Brand background color/);
  await expect(color).toBeVisible();
  await color.fill("#abcdef");
  const currentResponse = await page.request.get("/api/workspace/settings");
  expect(currentResponse.status()).toBe(200);
  const current = await currentResponse.json();
  expect(
    (
      await page.request.post("/api/workspace/settings", {
        data: {
          brandBackgroundColor: "#445566",
          expectedDigest: current.digest,
        },
      })
    ).status(),
  ).toBe(200);
  await page
    .getByRole("tab", { name: "SHOPLINE connection", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Save and leave", exact: true })
    .click();
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "admin-tab-settings",
  );
  await dialog.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(color).toHaveValue("#abcdef");
  await page.getByRole("button", { name: /Compare latest settings/ }).click();
  await expect(page.getByRole("tabpanel")).toContainText("#445566");
  await expect(color).toHaveValue("#abcdef");
  await page
    .getByRole("button", { name: /Reload and discard my edits/ })
    .click();
  await expect(color).toHaveValue("#445566");
  const settingsTab = page.getByRole("tab", { name: "Settings", exact: true });
  await settingsTab.focus();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "Members", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "System Truth", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "Runtime readiness" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Runtime readiness" }),
  ).toContainText("Unknown");
  await page
    .getByRole("tab", { name: "SHOPLINE connection", exact: true })
    .click();
  await page
    .getByLabel(/SHOPLINE shop domain/)
    .fill("synthetic-admin.myshopline.com");
  await page
    .getByLabel(/SHOPLINE access token/)
    .fill("synthetic-local-connection-token");
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await dialog.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(page.getByLabel(/SHOPLINE access token/)).toHaveValue(
    "synthetic-local-connection-token",
  );
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Save and leave", exact: true })
    .click();
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "admin-tab-members",
  );
  const connection = await page.request.get("/api/workspace/connection");
  expect(connection.status()).toBe(200);
  const connectionBody = await connection.json();
  expect(connectionBody.connection.shopDomain).toBe(
    "synthetic-admin.myshopline.com",
  );
  expect(JSON.stringify(connectionBody)).not.toContain(
    "synthetic-local-connection-token",
  );
  await page.screenshot({
    path: testInfo.outputPath("synthetic-admin-dirty.png"),
    fullPage: true,
  });
});
test("operator is rejected by admin readiness, settings and policy endpoints", async ({
  page,
}) => {
  const fixture = await prepareBulkImportFixture();
  await signInBulkImportOperator(page, fixture, false);
  expect((await page.request.get("/api/workspace/readiness")).status()).toBe(
    403,
  );
  expect((await page.request.get("/api/workspace/settings")).status()).toBe(
    403,
  );
  expect(
    (
      await page.request.post("/api/workspace/settings", {
        data: {
          brandBackgroundColor: "#112233",
          expectedDigest: "a".repeat(64),
        },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.patch("/api/workspace/policies", { data: {} })
    ).status(),
  ).toBe(403);
});

test("native SPA Back preserves dirty admin URL and inputs until save or discard is approved", async ({
  page,
}) => {
  const fixture = await prepareBulkImportFixture();
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`update memberships set role='admin' where workspace_id=${fixture.workspaceId} and user_id=${fixture.userId}`;
  } finally {
    await admin.end();
  }
  await signInBulkImportOperator(page, fixture, false);
  await page.goto("/catalog");
  await page.locator('a[href="/admin"]').first().click();
  await expect(page).toHaveURL(/\/admin$/);
  const invite = page.getByLabel(/Invite email address/);
  await expect(page.locator(".members-panel")).toContainText(fixture.email);
  await invite.fill("native-back-draft@local.invalid");
  const length = await page.evaluate(() => {
    console.log("t09-history " + JSON.stringify({ event: "before-dirty-traversal", path: location.pathname, length: history.length, marker: history.state?.__wukongAdminHistory?.index ?? null, index: (window as any).navigation?.currentEntry?.index ?? null }));
    return history.length;
  });
  await page.evaluate(() => history.back());
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(invite).toHaveValue("native-back-draft@local.invalid");
  await dialog.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.evaluate(() => history.back());
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/catalog$/);
  await page.locator('a[href="/admin"]').first().click();
  await expect(page).toHaveURL(/\/admin$/);
  await invite.fill("native-back-save@local.invalid");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failed = false;
  await page.route("**/api/workspace/members/invite", async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic invitation conflict" }),
      });
    } else {
      await held;
      await route.continue();
    }
  });
  await page.evaluate(() => history.back());
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Save and leave", exact: true })
    .click();
  await expect(page.locator(".members-panel [role=alert]")).toContainText(
    "Synthetic invitation conflict",
  );
  await expect(page).toHaveURL(/\/admin$/);
  await expect(invite).toHaveValue("native-back-save@local.invalid");
  await dialog
    .getByRole("button", { name: "Save and leave", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Save and leave", exact: true }),
  ).toBeDisabled();
  await expect(page).toHaveURL(/\/admin$/);
  release();
  await expect(page).toHaveURL(/\/catalog$/);
  const members = await page.request.get("/api/workspace/members");
  expect(members.status()).toBe(200);
  expect(
    (await members.json()).invites.some(
      (row: any) => row.email === "native-back-save@local.invalid",
    ),
  ).toBe(true);
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/listings\/import$/);
});
test("unindexed SPA forward and multi-entry Back keep dirty admin until the exact destination is approved", async ({
  page,
}) => {
  const fixture = await prepareBulkImportFixture();
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`update memberships set role='admin' where workspace_id=${fixture.workspaceId} and user_id=${fixture.userId}`;
  } finally {
    await admin.end();
  }
  await page.addInitScript(() => {
    Object.defineProperty(window, "navigation", {
      value: undefined,
      configurable: true,
    });
  });
  await signInBulkImportOperator(page, fixture, false);
  await page.goto("/catalog");
  await page.locator('a[href="/admin"]').first().click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.locator('a[href="/catalog"]').first().click();
  await expect(page).toHaveURL(/\/catalog(?:\?|$)/);
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/admin$/);
  const invite = page.getByLabel(/Invite email address/);
  await invite.fill("unindexed-forward@local.invalid");
  const length = await page.evaluate(() => {
    console.log("t09-history " + JSON.stringify({ event: "before-dirty-traversal", path: location.pathname, length: history.length, marker: history.state?.__wukongAdminHistory?.index ?? null, index: (window as any).navigation?.currentEntry?.index ?? null }));
    return history.length;
  });
  await page.evaluate(() => history.forward());
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(invite).toHaveValue("unindexed-forward@local.invalid");
  expect(await page.evaluate(() => history.length)).toBe(length);
  await dialog
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/catalog(?:\?|$)/);
  await page.locator('a[href="/jobs"]').first().click();
  await expect(page).toHaveURL(/\/jobs(?:\?|$)/);
  await page.locator('a[href="/admin"]').first().click();
  await expect(page).toHaveURL(/\/admin$/);
  await invite.fill("unindexed-multi-save@local.invalid");
  const multiLength = await page.evaluate(() => history.length);
  await page.evaluate(() => history.go(-2));
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(invite).toHaveValue("unindexed-multi-save@local.invalid");
  expect(await page.evaluate(() => history.length)).toBe(multiLength);
  await dialog
    .getByRole("button", { name: "Save and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/catalog(?:\?|$)/);
  const members = await page.request.get("/api/workspace/members");
  expect(members.status()).toBe(200);
  expect(JSON.stringify(await members.json())).toContain(
    "unindexed-multi-save@local.invalid",
  );
});
