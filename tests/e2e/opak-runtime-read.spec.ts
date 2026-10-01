import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import postgres from "postgres";
import { emptyWorkingListing } from "../../packages/core/src/working-listing.js";
import {
  ADMIN_URL,
  RUNTIME_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";
import {
  assertNoHorizontalOverflow,
  localBrowserUrl,
} from "./catalog-usability-checks.js";

test.skip(
  process.env.WUKONG_OPAK_E2E !== "1",
  "Opt into task-owned synthetic Opak runtime acceptance.",
);
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

for (const role of ["operator", "reviewer"] as const)
  test(`${role} reads healthy, malformed and no-version records through real auth and RLS`, async ({
    page,
  }, testInfo) => {
    localBrowserUrl(testInfo.project.use.baseURL);
    for (const raw of [ADMIN_URL, RUNTIME_URL]) {
      const url = new URL(raw);
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        !url.pathname.startsWith("/opak_fixes_")
      )
        throw new Error("Task-owned loopback database required");
    }
    const fixture = await prepareBulkImportFixture();
    const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const content = {
      ...emptyWorkingListing(),
      sku: "000674",
      packQuantity: 1,
      title: { en: "SYN Healthy 2020", "zh-Hant": "合成正常 2020" },
      description: { en: "Synthetic summary", "zh-Hant": "合成摘要" },
      seo: {
        title: { en: "Synthetic SEO", "zh-Hant": "合成 SEO" },
        description: {
          en: "Synthetic SEO summary",
          "zh-Hant": "合成 SEO 摘要",
        },
      },
    };
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    const mutations: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/listings") && request.method() !== "GET")
        mutations.push(path);
    });
    try {
      await admin`update memberships set role=${role} where workspace_id=${fixture.workspaceId} and user_id=${fixture.userId}`;
      for (const [index, id] of ids.entries()) {
        await admin`insert into listing_drafts(id,workspace_id,target,status,note) values (${id},${fixture.workspaceId},'shopline',${index === 4 ? "needs_info" : "in_review"},${index === 3 ? "Synthetic blocked identity" : "Synthetic manual draft"})`;
        if (index === 4) continue;
        const versionId = randomUUID();
        await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by)
        values (${versionId},${fixture.workspaceId},${id},1,${admin.json(index === 3 ? { ...content, title: null } : content)},${fixture.userId})`;
        await admin`update listing_drafts set active_version_id=${versionId} where id=${id}`;
      }
      await signInBulkImportOperator(page, fixture, false);
      await page.goto("/queue");
      await expect(page.locator(".queue-item")).toHaveCount(5);
      const blocked = page
        .locator(".queue-item")
        .filter({ has: page.locator(`a[href="/listings/${ids[3]}"]`).first() });
      await expect(blocked).toContainText("Record unavailable");
      await expect(blocked.getByRole("checkbox")).toBeDisabled();
      await expect(blocked).toContainText(/Support ID: [a-f0-9-]{36}/);
      await mkdir(resolve("node_modules/.opak-evidence"), { recursive: true });
      await page.screenshot({
        path: resolve(`node_modules/.opak-evidence/${role}-queue.png`),
        fullPage: true,
      });
      await page.goto(`/listings/${ids[3]}`);
      await expect(
        page.getByRole("heading", { name: "Listing record unavailable" }),
      ).toBeVisible();
      await expect(page.locator("main").getByRole("alert")).toContainText(
        /Support ID: [a-f0-9-]{36}/,
      );
      await expect(page.locator("main input, main textarea")).toHaveCount(0);
      await page.setViewportSize({ width: 375, height: 900 });
      await assertNoHorizontalOverflow(page);
      await page.screenshot({
        path: resolve(`node_modules/.opak-evidence/${role}-blocked-mobile.png`),
        fullPage: true,
      });
      await page.goto(`/listings/${ids[4]}`);
      await expect(
        page.getByLabel("Merchant SKU", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Merchant SKU", { exact: true }),
      ).toHaveValue("");
      await page.goto(`/listings/${ids[0]}`);
      await expect(
        page.getByRole("heading", { name: "合成正常 2020", exact: true }),
      ).toBeVisible();
      expect(pageErrors).toEqual([]);
      expect(mutations).toEqual([]);
    } finally {
      await admin.end();
    }
  });
