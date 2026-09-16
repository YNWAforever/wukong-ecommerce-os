import { expect, test } from "@playwright/test";
import * as pdfLib from "../../apps/web/node_modules/pdf-lib/cjs/index.js";

const { PDFDocument } = pdfLib;

import {
  enrollAndSignInOpakAdmin,
  prepareRealStackFixture,
} from "./real-stack-fixture.js";

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  test.skip(
    process.env.PLAYWRIGHT_E2E !== "1",
    "Set PLAYWRIGHT_E2E=1 to run the guarded local browser fixture.",
  );
  await prepareRealStackFixture();
});

test("native Chromium preserves append, remove, reselect, cancel, and previews", async ({
  page,
}) => {
  await enrollAndSignInOpakAdmin(page);
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const front = {
    name: "front-label.png",
    mimeType: "image/png",
    buffer: pixel,
  };
  const input = page.locator("#listing-files");

  await input.setInputFiles(front);
  await input.setInputFiles({
    name: "back-label.png",
    mimeType: "image/png",
    buffer: pixel,
  });
  await expect(page.locator(".file-row strong")).toHaveText([
    "front-label.png",
    "back-label.png",
  ]);

  await page
    .locator(".file-row", { hasText: "front-label.png" })
    .getByRole("button", { name: /移除/ })
    .click();
  await input.setInputFiles(front);
  await input.setInputFiles([]);

  await expect(page.locator(".file-row strong")).toHaveText([
    "back-label.png",
    "front-label.png",
  ]);
  await expect(page.locator(".file-preview")).toHaveCount(2);
  await page.screenshot({
    path: "test-results/t03-native-selection.png",
    fullPage: true,
  });
});

test("manual note-only draft survives reload without an active version", async ({
  page,
}) => {
  await enrollAndSignInOpakAdmin(page);
  const note =
    "Synthetic recovery note: merchant facts will be entered manually.";

  await page.getByLabel("補充備註").fill(note);
  await page.getByLabel("只儲存草稿，稍後手動處理").check();
  await page.getByRole("button", { name: /建立上架草稿/ }).click();
  await expect(page).toHaveURL(/\/listings\/[0-9a-f-]{36}\?processing=saved$/i);
  const listingId = page.url().match(/\/listings\/([0-9a-f-]{36})/i)?.[1];
  expect(listingId).toBeTruthy();

  const api = await page.request.get(`/api/listings/${listingId}`);
  expect(api.status()).toBe(200);
  expect(await api.json()).toMatchObject({
    activeVersion: null,
    workingInput: { revision: 1, note },
    currentRun: null,
  });

  await page.reload();
  await expect(
    page.getByRole("region", {
      name: /商品工作草稿|Product working draft/,
    }),
  ).toBeVisible();
  await expect(page.getByLabel(/來源備註|Source note/)).toHaveValue(note);
  await expect(page.getByText(/工作草稿版本 1|Input revision 1/)).toBeVisible();

  const correctedNote = `${note} Corrected after merchant review.`;
  await page.getByLabel(/來源備註|Source note/).fill(correctedNote);
  await page.getByLabel(/生產商|Producer/).fill("Synthetic Estate");
  await page.getByRole("button", { name: /只保存草稿|Save draft/ }).click();
  await expect(page.getByText(/工作草稿版本 2|Input revision 2/)).toBeVisible();

  const correctedApi = await page.request.get(`/api/listings/${listingId}`);
  expect(correctedApi.status()).toBe(200);
  expect(await correctedApi.json()).toMatchObject({
    activeVersion: null,
    workingInput: {
      revision: 2,
      note: correctedNote,
      workingContent: { producer: "Synthetic Estate" },
    },
    currentRun: null,
  });

  await page.reload();
  await expect(page.getByLabel(/來源備註|Source note/)).toHaveValue(
    correctedNote,
  );
  await expect(page.getByLabel(/生產商|Producer/)).toHaveValue(
    "Synthetic Estate",
  );
  await expect(page.getByText(/工作草稿版本 2|Input revision 2/)).toBeVisible();
  await page.screenshot({
    path: "test-results/t09-manual-recovery.png",
    fullPage: true,
  });
});

test("needs-info run preserves correction and starts an immutable retry", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await enrollAndSignInOpakAdmin(page);
  const document = await PDFDocument.create();
  document.addPage([72, 72]);
  await page.locator("#listing-files").setInputFiles({
    name: "unclear-supplier-sheet.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await document.save()),
  });
  await page.getByLabel("補充備註").fill("Unclear synthetic merchant item.");
  await page.getByRole("button", { name: /建立上架草稿/ }).click();
  await expect(page).toHaveURL(
    /\/listings\/[0-9a-f-]{36}\?processing=queued$/i,
  );
  const listingId = page.url().match(/\/listings\/([0-9a-f-]{36})/i)?.[1];
  expect(listingId).toBeTruthy();

  let firstRunId = "";
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/listings/${listingId}`);
        if (!response.ok()) return false;
        const listing = (await response.json()) as {
          status?: string;
          currentRun?: { runId?: string; state?: string } | null;
        };
        firstRunId = listing.currentRun?.runId ?? "";
        return (
          listing.status === "needs_info" &&
          listing.currentRun?.state === "succeeded" &&
          Boolean(firstRunId)
        );
      },
      { message: "Initial run did not reach needs_info", timeout: 60_000 },
    )
    .toBe(true);

  await page.reload();
  await page
    .getByLabel(/來源備註|Source note/)
    .fill(
      "Synthetic Estate Riesling wine 2024, Germany, Mosel, 750ml, 12.5% ABV.",
    );
  await page.getByLabel(/生產商|Producer/).fill("Synthetic Estate");
  await page
    .getByRole("button", {
      name: /保存並交予 AI 處理|Save and process with AI/,
    })
    .click();

  let retryRunId = "";
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/listings/${listingId}`);
        if (!response.ok()) return false;
        const listing = (await response.json()) as {
          status?: string;
          workingInput?: {
            revision?: number;
            note?: string;
            workingContent?: { producer?: string | null };
          } | null;
          currentRun?: {
            runId?: string;
            state?: string;
            retryOfRunId?: string | null;
            attempt?: number;
          } | null;
        };
        retryRunId = listing.currentRun?.runId ?? "";
        return (
          listing.status === "in_review" &&
          listing.currentRun?.state === "succeeded" &&
          listing.currentRun?.attempt === 2 &&
          retryRunId !== firstRunId &&
          listing.workingInput?.revision === 2 &&
          listing.workingInput.workingContent?.producer === "Synthetic Estate"
        );
      },
      {
        message: "Corrected input did not produce a new immutable run",
        timeout: 60_000,
      },
    )
    .toBe(true);

  const originalRun = await page.request.get(
    `/api/listings/${listingId}/runs/${firstRunId}`,
  );
  expect(originalRun.status()).toBe(200);
  expect(await originalRun.json()).toMatchObject({
    runId: firstRunId,
    state: "succeeded",
    retryOfRunId: null,
    inputRevision: 1,
  });

  await page.reload();
  await page
    .getByText(/編輯來源、備註及工作草稿|Edit sources, notes and working draft/)
    .click();
  await expect(page.getByLabel(/來源備註|Source note/)).toHaveValue(
    "Synthetic Estate Riesling wine 2024, Germany, Mosel, 750ml, 12.5% ABV.",
  );
  const workingDraft = page.getByRole("region", {
    name: /商品工作草稿|Product working draft/,
  });
  await expect(workingDraft.getByLabel(/生產商|Producer/)).toHaveValue(
    "Synthetic Estate",
  );
  await workingDraft.screenshot({
    path: "test-results/t09-needs-info-recovery.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await workingDraft.screenshot({
    path: "test-results/t09-needs-info-recovery-mobile.png",
  });
});
