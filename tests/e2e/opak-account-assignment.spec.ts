import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  ADMIN_URL,
  RUNTIME_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";
import {
  localBrowserUrl,
  assertNoHorizontalOverflow,
} from "./catalog-usability-checks.js";

test.skip(
  process.env.WUKONG_OPAK_E2E !== "1",
  "Opt into task-owned synthetic account and assignment acceptance.",
);
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);
function guard(baseURL: string | undefined) {
  localBrowserUrl(baseURL);
  for (const raw of [ADMIN_URL, RUNTIME_URL]) {
    const url = new URL(raw);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.pathname.startsWith("/opak_fixes_")
    )
      throw Error("Task-owned loopback database required");
  }
}

test("real Better Auth logout revokes session, clears stored work and keeps back protected", async ({
  page,
}, testInfo) => {
  guard(testInfo.project.use.baseURL);
  const fixture = await prepareBulkImportFixture();
  await signInBulkImportOperator(page, fixture, false);
  await page.goto("/catalog");
  await page.evaluate(() =>
    sessionStorage.setItem("wukong:catalog:selection:synthetic", "{}"),
  );
  await page.getByTestId("account-menu").locator("summary").click();
  await expect(page.getByTestId("account-menu")).toContainText(fixture.email);
  await expect(page.getByTestId("account-menu")).toContainText("Operator");
  await page.setViewportSize({ width: 375, height: 900 });
  await assertNoHorizontalOverflow(page);
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/signin$/);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("wukong:catalog:selection:synthetic"),
    ),
  ).toBeNull();
  expect((await page.request.get("/api/account")).status()).toBe(401);
  expect((await page.request.get("/api/listings")).status()).toBe(401);
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const sessions =
      await admin`select count(*)::int as count from auth_sessions where user_id=${fixture.userId}`;
    expect(sessions[0]?.count).toBe(0);
  } finally {
    await admin.end();
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/signin/);
  expect((await page.request.get("/api/account")).status()).toBe(401);
});

test("operator admin permission page and current role/member revocation stay server-authoritative", async ({
  page,
}, testInfo) => {
  guard(testInfo.project.use.baseURL);
  const fixture = await prepareBulkImportFixture();
  await signInBulkImportOperator(page, fixture, false);
  const listingId = randomUUID();
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: /Admin access required/ }),
  ).toBeVisible();
  await expect(page.locator('a[href="/catalog"]').last()).toBeVisible();
  expect((await page.request.get("/api/workspace/members")).status()).toBe(403);
  expect(
    (
      await page.request.post("/api/listings/" + listingId + "/approve", {
        data: {},
      })
    ).status(),
  ).toBe(403);
  // CSV delivery is a reviewer endpoint; assignment never lifts this gate.
  expect(
    (
      await page.request.post("/api/listings/" + listingId + "/deliver", {
        data: { method: "csv" },
      })
    ).status(),
  ).toBe(403);
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`update memberships set role='viewer' where workspace_id=${fixture.workspaceId} and user_id=${fixture.userId}`;
    expect(
      (
        await page.request.post("/api/listings/assign", {
          data: {
            items: [
              {
                listingId,
                assigneeUserId: fixture.userId,
                expectedRevision: 0,
                idempotencyKey: randomUUID(),
                action: "claim",
              },
            ],
          },
        })
      ).status(),
    ).toBe(403);
    await page.goto("/catalog");
    await page.getByTestId("account-menu").locator("summary").click();
    await expect(page.getByTestId("account-menu")).toContainText("Viewer");
    await admin`delete from memberships where workspace_id=${fixture.workspaceId} and user_id=${fixture.userId}`;
    expect((await page.request.get("/api/account")).status()).toBe(401);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/signin/);
  } finally {
    await admin.end();
  }
});

test("two authenticated operators racing to claim have one winner and one audited assignment", async ({
  page,
  browser,
}, testInfo) => {
  guard(testInfo.project.use.baseURL);
  const first = await prepareBulkImportFixture(),
    second = await prepareBulkImportFixture();
  const listingId = randomUUID();
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  const secondContext = await browser.newContext({
    baseURL: String(testInfo.project.use.baseURL),
  });
  const secondPage = await secondContext.newPage();
  try {
    await admin`insert into memberships(workspace_id,user_id,role) values (${first.workspaceId},${second.userId},'operator')`;
    await admin`insert into listing_drafts(id,workspace_id,target,note) values (${listingId},${first.workspaceId},'shopline','Synthetic claim race')`;
    await signInBulkImportOperator(page, first, false);
    await signInBulkImportOperator(secondPage, second, false);
    const runtime = postgres(RUNTIME_URL, { max: 1, prepare: false });
    try {
      const rows =
        await runtime`select exists(select 1 from auth_get_active_membership(${second.userId},${first.workspaceId}) where workspace_id=${first.workspaceId} and actor_id=${second.userId} and role='operator') as allowed`;
      expect(rows[0]?.allowed).toBe(true);
    } finally {
      await runtime.end();
    }
    const identity = await secondPage.request.get("/api/account");
    expect(identity.status()).toBe(200);
    expect((await identity.json()).user.userId).toBe(second.userId);
    const switchResponse = secondPage.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/select"),
    );
    await secondPage
      .getByRole("combobox", { name: "Select workspace", exact: true })
      .selectOption(first.workspaceId);
    const switched = await switchResponse;
    expect(await switched.request().headerValue("origin")).toBe(
      new URL(String(testInfo.project.use.baseURL)).origin,
    );
    expect(switched.status()).toBe(200);
    await expect(secondPage).toHaveURL(/\/dashboard$/);
    const claim = (userId: string) => ({
      items: [
        {
          listingId,
          assigneeUserId: userId,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          action: "claim",
        },
      ],
    });
    const responses = await Promise.all([
      page.request.post("/api/listings/assign", { data: claim(first.userId) }),
      secondPage.request.post("/api/listings/assign", {
        data: claim(second.userId),
      }),
    ]);
    expect(responses.every((response) => response.status() === 200)).toBe(true);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(bodies.map((body) => body.results[0].outcome).sort()).toEqual([
      "assigned",
      "revision_conflict",
    ]);
    const rows =
      await admin`select count(*)::int as count from audit_events where workspace_id=${first.workspaceId} and entity_id=${listingId} and action='listing.assigned'`;
    expect(rows[0]?.count).toBe(1);
    const snapshot = await (
      await page.request.get("/api/listings/assign?listingIds=" + listingId)
    ).json();
    expect(snapshot.assignments[0].assignmentRevision).toBe(1);
    const state =
      await admin`select status from listing_drafts where id=${listingId}`;
    expect(state[0]?.status).toBe("received");
  } finally {
    await secondContext.close();
    await admin.end();
  }
});
