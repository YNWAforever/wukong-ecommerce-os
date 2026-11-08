import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  ADMIN_URL,
  RUNTIME_URL,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";
import { hashPassword } from "../../apps/web/lib/password-crypto.js";
import { localBrowserUrl } from "./catalog-usability-checks.js";
test.skip(
  process.env.WUKONG_OPAK_E2E !== "1" || process.env.PLAYWRIGHT_E2E !== "1",
  "Explicit local synthetic Opak workspace-switch admission only",
);
test.describe.configure({ mode: "serial" });
test.setTimeout(120000);
function guard(baseURL: string | undefined) {
  localBrowserUrl(baseURL);
  for (const raw of [ADMIN_URL, RUNTIME_URL]) {
    const url = new URL(raw);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.pathname.startsWith("/opak_fixes_")
    )
      throw Error("Dedicated task-owned loopback database required");
  }
  const admin = new URL(ADMIN_URL),
    runtime = new URL(RUNTIME_URL);
  if (admin.port !== runtime.port || admin.pathname !== runtime.pathname)
    throw Error(
      "Browser fixture and runtime must use the same dedicated database",
    );
}
async function setup(page: import("@playwright/test").Page) {
  const suffix = randomUUID(),
    userId = `user_guard_${suffix}`,
    email = `guard-admin-${suffix}@local.invalid`,
    password = "Synthetic guard password 1!";
  const first = {
      workspaceId: `ws_guard_first_${suffix}`,
      userId,
      email,
      password,
      connectionId: randomUUID(),
    },
    second = { workspaceId: `ws_guard_second_${suffix}` };
  const profile = {
    name: "Synthetic guarded admin workspace",
    currency: "HKD",
    locales: ["en", "zh-Hant"],
    tone: "Plain",
    claimPolicy: [],
    requiredFields: [],
  };
  const passwordHash = await hashPassword(password),
    db = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await db.begin(async (sql) => {
      await sql`insert into workspaces(id,name,profile) values (${first.workspaceId},'Synthetic guarded first',${sql.json(profile)}),(${second.workspaceId},'Synthetic guarded second',${sql.json(profile)})`;
      await sql`insert into users(id,email,auth_email_verified) values (${userId},${email},true)`;
      await sql`insert into memberships(workspace_id,user_id,role) values (${first.workspaceId},${userId},'admin')`;
      await sql`insert into memberships(workspace_id,user_id,role) values (${second.workspaceId},${userId},'admin')`;
      await sql`insert into workspace_invites(workspace_id,email,role,status) values (${first.workspaceId},${email},'admin','accepted')`;
      await sql`insert into auth_accounts(id,user_id,account_id,provider_id,password) values (${randomUUID()},${userId},${userId},'credential',${passwordHash})`;
    });
  } finally {
    await db.end();
  }
  page.on("dialog", (dialog) => void dialog.dismiss());
  await signInBulkImportOperator(page, first, false);
  await page.goto("/admin");
  expect(
    (await (await page.request.get("/api/account")).json()).workspaceId,
  ).toBe(first.workspaceId);
  return { first, second };
}
test("dirty workspace Stay and failed Save keep old session; approved Save writes only old tenant and switches once", async ({
  page,
}, info) => {
  guard(info.project.use.baseURL);
  const { first, second } = await setup(page);
  let switches = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/workspace/select"
    )
      switches++;
  });
  const email = `guard-${randomUUID()}@local.invalid`,
    input = page.getByRole("textbox", { name: /Invite email address/ });
  await input.fill(email);
  await page.getByTestId("workspace-select").selectOption(second.workspaceId);
  const dialog = page.getByRole("alertdialog");
  try {
    await expect(dialog).toBeVisible();
  } catch (error) {
    const account = await (await page.request.get("/api/account")).json();
    console.warn(
      JSON.stringify({
        workspaceGuardEvidence: {
          workspaceSwitchRequests: switches,
          sessionStayedOriginal: account.workspaceId === first.workspaceId,
          uiStayedAdmin: new URL(page.url()).pathname === "/admin",
        },
      }),
    );
    throw error;
  }
  expect(switches).toBe(0);
  await dialog.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(input).toHaveValue(email);
  expect(switches).toBe(0);
  expect(
    (await (await page.request.get("/api/account")).json()).workspaceId,
  ).toBe(first.workspaceId);
  await input.fill("invalid-email");
  await page.getByTestId("workspace-select").selectOption(second.workspaceId);
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Save and leave", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("invalid-email");
  expect(switches).toBe(0);
  expect(
    (await (await page.request.get("/api/account")).json()).workspaceId,
  ).toBe(first.workspaceId);
  await dialog.getByRole("button", { name: "Stay here", exact: true }).click();
  await input.fill(email);
  await page.getByTestId("workspace-select").selectOption(second.workspaceId);
  await expect(dialog).toBeVisible();
  expect(switches).toBe(0);
  const [savedInvite, switchedWorkspace] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workspace/members/invite" &&
        response.request().method() === "POST",
      { timeout: 5000 },
    ),
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workspace/select" &&
        response.request().method() === "POST",
      { timeout: 5000 },
    ),
    dialog.getByRole("button", { name: "Save and leave", exact: true }).click(),
  ]);
  expect(savedInvite.status()).toBe(200);
  expect(switchedWorkspace.status()).toBe(200);
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(switches).toBe(1);
  expect(
    (await (await page.request.get("/api/account")).json()).workspaceId,
  ).toBe(second.workspaceId);
  const db = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const rows =
      await db`select workspace_id,count(*)::int as count from workspace_invites where email=${email} group by workspace_id`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace_id).toBe(first.workspaceId);
    expect(rows[0]?.count).toBe(1);
  } finally {
    await db.end();
  }
});
test("approved workspace Discard switches once without creating either tenant's draft invite", async ({
  page,
}, info) => {
  guard(info.project.use.baseURL);
  const { first, second } = await setup(page);
  let switches = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/workspace/select"
    )
      switches++;
  });
  const email = `discard-${randomUUID()}@local.invalid`;
  await page.getByRole("textbox", { name: /Invite email address/ }).fill(email);
  await page.getByTestId("workspace-select").selectOption(second.workspaceId);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  expect(switches).toBe(0);
  await dialog
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(switches).toBe(1);
  expect(
    (await (await page.request.get("/api/account")).json()).workspaceId,
  ).toBe(second.workspaceId);
  const db = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const rows =
      await db`select count(*)::int as count from workspace_invites where email=${email} and workspace_id in (${first.workspaceId},${second.workspaceId})`;
    expect(rows[0]?.count).toBe(0);
  } finally {
    await db.end();
  }
});
test("accepted delayed workspace POST holds native Back, links, tabs and second choices until one completion", async ({
  page,
}, info) => {
  guard(info.project.use.baseURL);
  await page.addInitScript(() => {
    const context = window as Window & { __opakGuardPopCount?: number };
    context.__opakGuardPopCount = 0;
    window.addEventListener("popstate", () => {
      context.__opakGuardPopCount = (context.__opakGuardPopCount ?? 0) + 1;
    });
  });
  const { first, second } = await setup(page);
  await page.goto("/jobs");
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await test.step("Admin content is ready after Jobs → Admin SPA return", async () => {
    await expect(
      page.getByRole("heading", {
        name: /^(工作區管理|Workspace administration)$/,
      }),
      "Admin heading must render after the SPA return",
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("tabpanel"),
      "Members panel must render",
    ).toHaveAttribute("aria-labelledby", "admin-tab-members");
    await expect(
      page.getByRole("textbox", { name: /Invite email address/ }),
      "Invite textbox must render before the workspace switch",
    ).toBeVisible();
  });
  const before = await page.evaluate(() => ({
    count:
      (window as Window & { __opakGuardPopCount?: number })
        .__opakGuardPopCount ?? 0,
    index: (
      window as Window & { navigation?: { currentEntry?: { index?: number } } }
    ).navigation?.currentEntry?.index,
  }));
  let release!: () => void,
    switches = 0,
    routeCompleted = false;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitForCompletion = () =>
    expect
      .poll(() => routeCompleted, {
        timeout: 11000,
        message: "Held workspace POST must settle after release",
      })
      .toBe(true);
  await page.route("**/api/workspace/select", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    switches++;
    await hold;
    try {
      await route.fulfill({ response: await route.fetch({ timeout: 10000 }) });
    } finally {
      routeCompleted = true;
    }
  });
  const draftEmail = `delayed-${randomUUID()}@local.invalid`;
  let primaryFailed = false;
  try {
    await page
      .getByRole("textbox", { name: /Invite email address/ })
      .fill(draftEmail);
    await page.getByTestId("workspace-select").selectOption(second.workspaceId);
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Discard and leave", exact: true })
      .click();
    await expect
      .poll(() => switches, {
        timeout: 10000,
        message: "Discard must issue exactly one workspace POST",
      })
      .toBe(1);
    expect(switches).toBe(1);
    await expect(page.getByTestId("workspace-select")).toBeDisabled();
    expect(
      (await (await page.request.get("/api/account")).json()).workspaceId,
    ).toBe(first.workspaceId);
    await page.evaluate(() => window.history.back());
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __opakGuardPopCount?: number })
              .__opakGuardPopCount ?? 0,
        ),
      )
      .toBeGreaterThan(before.count);
    await expect(page).toHaveURL(/\/admin$/);
    if (before.index !== undefined)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  navigation?: { currentEntry?: { index?: number } };
                }
              ).navigation?.currentEntry?.index,
          ),
        )
        .toBe(before.index);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "admin-tab-members",
    );
    await page.getByRole("link", { name: "Catalog", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("workspace-select")).toBeDisabled();
    expect(switches).toBe(1);
    release();
    await waitForCompletion();
    await expect(page).toHaveURL(/\/dashboard$/);
    expect(switches).toBe(1);
    expect(
      (await (await page.request.get("/api/account")).json()).workspaceId,
    ).toBe(second.workspaceId);
    const db = postgres(ADMIN_URL, { max: 1, prepare: false });
    try {
      const rows =
        await db`select count(*)::int as count from workspace_invites where email=${draftEmail} and workspace_id in (${first.workspaceId},${second.workspaceId})`;
      expect(rows[0]?.count).toBe(0);
    } finally {
      await db.end();
    }
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    release();
    try {
      if (switches > 0 && !page.isClosed()) await waitForCompletion();
      if (!page.isClosed()) await page.unroute("**/api/workspace/select");
    } catch (error) {
      // A timeout can close the page while route cleanup is in flight.
      // Keep its primary assertion; cleanup still fails an otherwise healthy test.
      if (!primaryFailed && !page.isClosed()) throw error;
    }
  }
});
