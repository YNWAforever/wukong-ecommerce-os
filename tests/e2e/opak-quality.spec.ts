import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { createDatabase } from "../../packages/db/src/client.js";
import { emptyWorkingListing } from "../../packages/core/src/index.js";
import {
  ADMIN_URL,
  RUNTIME_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";

test("quality shows actual bounded progress, four distinct checks and revokes cached counts", async ({
  page,
}, info) => {
  test.skip(
    process.env.WUKONG_OPAK_E2E !== "1",
    "Explicit isolated Opak acceptance required.",
  );
  test.setTimeout(90_000);
  for (const raw of [
    ADMIN_URL,
    RUNTIME_URL,
    String(info.project.use.baseURL),
  ]) {
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(
      new URL(raw).hostname,
    );
  }
  expect(new URL(RUNTIME_URL).pathname).toMatch(/^\/opak_fixes_[a-z0-9_]+$/);
  expect(new URL(RUNTIME_URL).username).toBe("wukong_app");
  const fixture = await prepareBulkImportFixture();
  const database = createDatabase(RUNTIME_URL);
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await database.forWorkspace(fixture.workspaceId, async (repos) => {
      for (let index = 0; index < 28; index++) {
        const draft = await repos.listings.create({ target: "shopline" });
        await repos.listingInputs.initialize(
          {
            listingId: draft.id,
            actorId: fixture.userId,
            workingContent: {
              ...emptyWorkingListing(),
              sku: String(index + 1).padStart(6, "0"),
              title: { en: "Synthetic Estate", "zh-Hant": "示範酒莊" },
              description: {
                en: "Synthetic description",
                "zh-Hant": "合成產品描述",
              },
              seo: {
                title: {
                  en: "Shop synthetic wine",
                  "zh-Hant": "選購示範葡萄酒",
                },
                description: {
                  en: "Explore this synthetic estate",
                  "zh-Hant": "探索示範酒款",
                },
              },
              tags: ["wine", "estate"],
            },
          },
          {
            workspaceId: fixture.workspaceId,
            actorId: fixture.userId,
            entityId: draft.id,
          },
          repos.audit,
        );
      }
    });
    await signInBulkImportOperator(page, fixture, false);
    const firstRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/quality",
    );
    await page.goto("/quality");
    const first = await firstRead;
    expect(first.status()).toBe(200);
    expect(await first.json()).toMatchObject({
      totalListings: 28,
      totalAssessed: 25,
      cleanCount: 25,
      noActiveVersion: 28,
      totalCostUsd: 0,
      projection: {
        state: "pending",
        pendingCount: 3,
        failedCount: 0,
        stale: true,
      },
    });
    await expect(page.locator("[data-quality-projection]")).toContainText(
      "Counts are incomplete: 3 pending; 0 failed",
    );
    for (const name of [
      "Copy gaps",
      "Fact evidence",
      "Human verification",
      "Delivery readiness",
      "AI cost reconciliation",
    ]) {
      await expect(
        page.getByRole("region", { name, exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("region", { name: "Fact evidence", exact: true }),
    ).toContainText("not aggregated");
    await expect(
      page.getByRole("region", { name: "Delivery readiness", exact: true }),
    ).toContainText(
      "neither authorize approval/export nor prove the store was updated",
    );
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/quality",
    );
    await page
      .getByRole("button", { name: "Refresh counts", exact: true })
      .click();
    expect(await (await refreshed).json()).toMatchObject({
      totalListings: 28,
      totalAssessed: 28,
      cleanCount: 28,
      projection: {
        state: "ready",
        pendingCount: 0,
        failedCount: 0,
        stale: false,
      },
    });
    await expect(page.locator("[data-quality-projection]")).toContainText(
      "Current content counts updated",
    );
    await page.screenshot({
      path: info.outputPath("quality-current-counts.png"),
      fullPage: true,
    });
    const [providers] =
      await admin`select count(*)::int count from ai_runs where workspace_id=${fixture.workspaceId}`;
    expect(providers?.count).toBe(0);
    // Removing actual membership must hide the earlier successful projection on the next observation.
    await admin`delete from memberships where workspace_id=${fixture.workspaceId} and user_id=${fixture.userId}`;
    const revoked = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/quality",
    );
    await page
      .getByRole("button", { name: "Refresh counts", exact: true })
      .click();
    expect([401, 403]).toContain((await revoked).status());
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Quality metrics", exact: true }),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await database.close();
    await admin.end();
  }
});
