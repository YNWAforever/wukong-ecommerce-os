import { expect, test } from "@playwright/test";
import { contentFieldLabel } from "../../apps/web/lib/content-field-labels.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { createDatabase } from "../../packages/db/src/client.js";
import { emptyWorkingListing } from "../../packages/core/src/index.js";
import {
  ADMIN_URL,
  RUNTIME_URL,
  prepareBulkImportFixture,
  signInBulkImportOperator,
} from "./real-stack-fixture.js";

test("operator selects 5 across pages, previews without calls and fake Queue preserves all other current values", async ({
  page,
}, info) => {
  test.skip(
    process.env.WUKONG_OPAK_E2E !== "1",
    "Explicit isolated Opak acceptance required.",
  );
  test.setTimeout(180_000);
  for (const target of [
    new URL(ADMIN_URL),
    new URL(RUNTIME_URL),
    new URL(String(info.project.use.baseURL)),
  ])
    expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
  expect(new URL(ADMIN_URL).pathname).toMatch(/^\/opak_fixes_[a-z0-9_]+$/);
  const fixture = await prepareBulkImportFixture();
  const db = createDatabase(RUNTIME_URL, { migrationUrl: ADMIN_URL });
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const seeded = await db.forWorkspace(fixture.workspaceId, async (repos) => {
      const rows = [];
      for (let index = 0; index < 28; index++) {
        const draft = await repos.listings.create({ target: "shopline" });
        const working = {
          ...emptyWorkingListing(),
          sku: String(index + 1).padStart(6, "0"),
          producer: "SYN Estate",
          productType: "wine",
          country: "France",
          volumeMl: 750,
          abvPercent: 12,
          packQuantity: 6,
          priceHkd: 128.5,
          stockQuantity: 9,
          title: { en: `Synthetic current ${index + 1}`, "zh-Hant": "" },
          description: {
            en: "Original English description",
            "zh-Hant": "原有人工完整描述",
          },
          seo: {
            title: {
              en: "Original English SEO",
              "zh-Hant": index === 27 ? "人工鎖定 SEO" : "",
            },
            description: {
              en: "Original SEO description",
              "zh-Hant": "原有人工 SEO 描述",
            },
          },
          tags: ["original keyword"],
        };
        await repos.listingInputs.initialize(
          {
            listingId: draft.id,
            actorId: fixture.userId,
            workingContent: working,
          },
          {
            workspaceId: fixture.workspaceId,
            actorId: fixture.userId,
            entityId: draft.id,
          },
          repos.audit,
        );
        if (index === 27)
          await repos.listingInputs.save(
            {
              listingId: draft.id,
              actorId: fixture.userId,
              expectedInputRevision: 1,
              baseVersionId: null,
              operationKey: randomUUID(),
              requestDigest: "a".repeat(64),
              changes: [
                {
                  field: "seo.title.zh-Hant",
                  value: "人工鎖定 SEO",
                  locked: true,
                },
              ],
            },
            {
              workspaceId: fixture.workspaceId,
              actorId: fixture.userId,
              entityId: draft.id,
            },
            repos.audit,
          );
        rows.push({ id: draft.id, working });
      }
      return rows;
    });
    await signInBulkImportOperator(page, fixture, false);
    await page.goto("/catalog?filter=drafts");
    await expect(
      page.getByRole("checkbox", { name: /for Bulk Update/ }),
    ).toHaveCount(25);
    const selected: string[] = [];
    async function select(count: number) {
      const boxes = page.getByRole("checkbox", { name: /for Bulk Update/ });
      for (let index = 0; index < count; index++) {
        const box = boxes.nth(index);
        const label = await box.getAttribute("aria-label");
        const identity = label!
          .replace(/^Select /, "")
          .replace(/ for Bulk Update$/, "");
        const row = seeded.find(
          (row) => row.working.sku === identity || row.id === identity,
        );
        expect(row).toBeDefined();
        selected.push(row!.id);
        await box.check();
      }
    }
    await select(2);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: /for Bulk Update/ }),
    ).toHaveCount(3);
    await select(3);
    await expect(
      page.getByText("5 selected for Bulk Update", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("2 selected products are outside this filter", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Website", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: /for Bulk Update/ }),
    ).toHaveCount(0);
    await expect(
      page.getByText("5 selected products are outside this filter", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByLabel("Label", { exact: true })
      .fill("Synthetic selected current content");
    await page.getByLabel("Budget (USD)", { exact: true }).fill("1");
    await page.getByLabel("Wave size (1-5)", { exact: true }).fill("5");
    await page
      .getByRole("group", { name: "Content fields to change" })
      .getByRole("checkbox", {
        name: contentFieldLabel("seoTitleZh", "en"),
        exact: true,
      })
      .check();
    const previewed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/enrichment-batches/preview" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Preview batch", exact: true })
      .click();
    expect((await previewed).status()).toBe(200);
    await expect(
      page.getByRole("region", { name: "Batch preview" }),
    ).toContainText("eligible 5");
    const [noCalls] =
      await admin`select count(*)::int count from ai_runs where workspace_id=${fixture.workspaceId}`;
    expect(noCalls!.count).toBe(0);
    const [noRuns] =
      await admin`select count(*)::int count from listing_pipeline_runs where workspace_id=${fixture.workspaceId}`;
    expect(noRuns!.count).toBe(0);
    const evidence = resolve("node_modules/.opak-evidence");
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: resolve(evidence, "selected-current-preview.png"),
      fullPage: true,
    });
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/enrichment-batches" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Confirm create batch", exact: true })
      .click();
    const response = await created;
    expect(response.status()).toBe(201);
    const receipt = await response.json();
    expect(receipt.selected).toBe(5);
    await page.goto("/batches/" + receipt.batchId);
    const advanced = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/enrichment-batches/${receipt.batchId}/advance` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /Advance/ }).click();
    expect((await advanced).status()).toBe(202);
    await expect
      .poll(
        async () =>
          Number(
            (
              await admin`select count(*)::int count from listing_drafts where workspace_id=${fixture.workspaceId} and active_version_id is not null`
            )[0]!.count,
          ),
        { timeout: 60_000 },
      )
      .toBe(5);
    const versions =
      await admin`select d.id,v.content from listing_drafts d join listing_versions v on v.workspace_id=d.workspace_id and v.id=d.active_version_id where d.workspace_id=${fixture.workspaceId}`;
    expect(versions.map((row) => row.id).sort()).toEqual([...selected].sort());
    for (const row of versions) {
      const original = seeded.find((seed) => seed.id === row.id)!.working;
      const content = row.content;
      expect(content.title["zh-Hant"]).not.toBe("");
      if (original.seo.title["zh-Hant"])
        expect(content.seo.title["zh-Hant"]).toBe(
          original.seo.title["zh-Hant"],
        );
      else expect(content.seo.title["zh-Hant"]).not.toBe("");
      const { title, seo, ...facts } = content;
      const {
        title: originalTitle,
        seo: originalSeo,
        ...originalFacts
      } = original;
      expect(facts).toEqual(originalFacts);
      expect(title.en).toBe(originalTitle.en);
      expect(seo.title.en).toBe(originalSeo.title.en);
      expect(seo.description).toEqual(originalSeo.description);
    }
    await expect
      .poll(
        async () =>
          Number(
            (
              await admin`select count(*)::int count from listing_drafts where workspace_id=${fixture.workspaceId} and status='in_review'`
            )[0]!.count,
          ),
        { timeout: 20_000 },
      )
      .toBe(5);
    expect(pageErrors).toEqual([]);
  } finally {
    await db.close();
    await admin.end();
  }
});

test("partial selected copy stays editable and can be adopted without completing unselected fields", async ({
  page,
}, info) => {
  test.skip(
    process.env.WUKONG_OPAK_E2E !== "1",
    "Explicit isolated Opak acceptance required.",
  );
  test.setTimeout(120_000);
  expect(new URL(ADMIN_URL).pathname).toMatch(/^\/opak_fixes_[a-z0-9_]+$/);
  expect(["127.0.0.1", "localhost"]).toContain(
    new URL(String(info.project.use.baseURL)).hostname,
  );
  const fixture = await prepareBulkImportFixture();
  const db = createDatabase(RUNTIME_URL, { migrationUrl: ADMIN_URL });
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const id = await db.forWorkspace(fixture.workspaceId, async (repos) => {
      const draft = await repos.listings.create({ target: "shopline" });
      await repos.listingInputs.initialize(
        {
          listingId: draft.id,
          actorId: fixture.userId,
          workingContent: {
            ...emptyWorkingListing(),
            producer: "SYN Estate",
            productType: "wine",
            country: "France",
            packQuantity: 6,
            title: { en: "Synthetic partial current", "zh-Hant": "" },
          },
        },
        {
          workspaceId: fixture.workspaceId,
          actorId: fixture.userId,
          entityId: draft.id,
        },
        repos.audit,
      );
      return draft.id;
    });
    await signInBulkImportOperator(page, fixture, false);
    const previewed = await page.request.post(
      "/api/enrichment-batches/preview",
      {
        data: {
          label: "Synthetic partial copy",
          budgetUsd: 1,
          waveSize: 1,
          selection: { mode: "explicit", listingIds: [id], fields: ["nameZh"] },
        },
      },
    );
    expect(previewed.status()).toBe(200);
    const preview = await previewed.json();
    const created = await page.request.post("/api/enrichment-batches", {
      data: {
        previewId: preview.previewId,
        digest: preview.digest,
        idempotencyKey: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const { batchId } = await created.json();
    const advanced = await page.request.post(
      `/api/enrichment-batches/${batchId}/advance`,
      { data: { expectedControlRevision: 0, idempotencyKey: randomUUID() } },
    );
    expect(advanced.status()).toBe(202);
    await expect
      .poll(
        async () =>
          String(
            (
              await admin`select execution_state from listing_pipeline_runs where workspace_id=${fixture.workspaceId} and listing_id=${id}`
            )[0]?.execution_state,
          ),
        { timeout: 60_000 },
      )
      .toBe("succeeded");
    const [run] =
      await admin`select id,execution,result_status from listing_pipeline_runs where workspace_id=${fixture.workspaceId} and listing_id=${id}`;
    expect(run!.result_status).toBe("needs_info");
    expect(run!.execution.candidate.content.description).toEqual({
      en: "",
      "zh-Hant": "",
    });
    const read = await page.request.get("/api/listings/" + id);
    expect(read.status()).toBe(200);
    const view = await read.json();
    expect(view).toMatchObject({
      readState: "ready",
      status: "needs_info",
      activeVersion: null,
      permissions: { canEdit: true },
    });
    const adopted = await page.request.post(
      `/api/listings/${id}/runs/${run!.id}/adopt`,
      {
        headers: { "Idempotency-Key": randomUUID() },
        data: {
          expectedInputRevision: 1,
          baseVersionId: null,
          selectedFieldPaths: ["title.zh-Hant"],
        },
      },
    );
    expect(adopted.status()).toBe(200);
    const latest = await (await page.request.get("/api/listings/" + id)).json();
    expect(latest.readState).toBe("ready");
    expect(latest.activeVersion).toBeNull();
    expect(latest.workingInput.workingContent.title["zh-Hant"]).not.toBe("");
    expect(latest.workingInput.workingContent.description).toEqual({
      en: "",
      "zh-Hant": "",
    });
    expect(latest.workingInput.workingContent.seo).toEqual(
      emptyWorkingListing().seo,
    );
    const [versions] =
      await admin`select count(*)::int count from listing_versions where workspace_id=${fixture.workspaceId}`;
    expect(versions!.count).toBe(0);
    const copy = {
      en: "Synthetic manual completed copy",
      "zh-Hant": "合成人工完成內容",
    };
    const promoted = await page.request.put("/api/listings/" + id + "/review", {
      headers: { "Idempotency-Key": randomUUID() },
      data: {
        baseVersionId: null,
        expectedInputRevision: latest.workingInput.revision,
        content: {
          ...latest.workingInput.workingContent,
          description: copy,
          seo: { title: copy, description: copy },
        },
      },
    });
    expect(promoted.status()).toBe(200);
    const review = await (await page.request.get("/api/listings/" + id)).json();
    expect(review).toMatchObject({
      readState: "ready",
      status: "in_review",
      activeVersion: {
        content: {
          title: latest.workingInput.workingContent.title,
          description: copy,
        },
      },
    });
    expect(review.permissions.canApprove).toBe(false);
  } finally {
    await db.close();
    await admin.end();
  }
});
