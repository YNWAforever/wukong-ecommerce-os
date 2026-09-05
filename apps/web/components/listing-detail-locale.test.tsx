// @vitest-environment happy-dom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ConfirmationChecklist } from "./confirmation-checklist";
import { ImportResultForm } from "./import-result-form";
import { BulkExportPanel } from "./bulk-export-panel";
const preference = vi.hoisted(() => ({ locale: "en" as "en" | "zh-Hant" }));
vi.mock("../lib/locale-context", () => ({
  useLocale: () => preference.locale,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it.each(["en", "zh-Hant"] as const)(
  "localizes checklist and export controls in %s",
  (locale) => {
    preference.locale = locale;
    const markup = renderToStaticMarkup(
      createElement(ConfirmationChecklist, {
        fieldConfirmations: {},
        negativeConfirmations: {},
        canConfirm: true,
      }),
    );
    expect(markup).toContain(
      locale === "en" ? "Confirm before approval" : "批准前需要確認",
    );
    expect(markup).not.toContain(
      locale === "en" ? "售價未變動" : "Price unchanged",
    );
    const exportMarkup = renderToStaticMarkup(
      createElement(BulkExportPanel, {
        listingIds: ["exact-id"],
        canGenerate: true,
      }),
    );
    expect(exportMarkup).toContain(
      locale === "en" ? "Generate Bulk Update XLSX" : "產生批量更新 XLSX",
    );
  },
);
it.each(["en", "zh-Hant"] as const)(
  "associates safe result failure and retains retry identity in %s",
  async (locale) => {
    preference.locale = locale;
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "secret internal payload" }), {
        status: 503,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(ImportResultForm, {
            mode: "export",
            listingId: "listing-exact",
            versionId: "version-exact",
            exportAttemptId: "attempt-exact",
          }),
        ),
      );
      const form = host.querySelector("form")!;
      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      expect(host.textContent).not.toContain("secret internal payload");
      const alert = host.querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain(
        locale === "en" ? "could not be completed" : "操作未能完成",
      );
      expect(form.getAttribute("aria-describedby")).toBe(alert.id);
      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      const first = JSON.parse(fetcher.mock.calls[0]![1].body);
      const second = JSON.parse(fetcher.mock.calls[1]![1].body);
      expect(first).toMatchObject({
        versionId: "version-exact",
        exportAttemptId: "attempt-exact",
      });
      expect(first.idempotencyKey).toBe(second.idempotencyKey);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  },
);

import {
  ExportReconciliationPanel,
  type WireExportReconciliationDetail,
} from "./export-reconciliation-panel";
import { ListingProcessingPanel } from "./listing-processing-panel";
import { ComplianceFlags } from "./compliance-flags";
import { EvidencePanel } from "./evidence-panel";
import { ProductShotPanel } from "./product-shot-panel";
import { ListingFieldsForm } from "./listing-fields-form";
import { DeliveryPanel } from "./delivery-panel";
const report = {
  id: "report-original",
  outcome: "rejected" as const,
  rejectReason: "商戶 reason 原文",
  correctionReason: "更正 correction 原文",
  revision: 1234,
  createdAt: "2026-01-01T00:00:00Z",
};
const detail: WireExportReconciliationDetail = {
  attempt: {
    id: "attempt-exact",
    artifactStatus: "ready",
    rowCount: 1,
    specVersion: "v1",
    createdAt: "2026-01-01T00:00:00Z",
  },
  reconciliation: {
    counts: {
      requested: 1,
      included: 1,
      excluded: 0,
      noOp: 0,
      accepted: 0,
      rejected: 1,
      unreported: 0,
    },
    verificationStatus: "unverified",
    members: [
      {
        listingId: "listing-exact",
        versionId: "version-exact",
        outcome: "included",
        latestResult: report,
        history: [report],
      },
    ],
  },
  capabilities: { canGenerateBulkUpdate: true, canRecordImportResult: true },
};
it.each(["en", "zh-Hant"] as const)(
  "keeps report data, HK dates, ready-only actions and unverified distinction in %s",
  (locale) => {
    preference.locale = locale;
    const markup = renderToStaticMarkup(
      createElement(ExportReconciliationPanel, { detail }),
    );
    expect(markup).toContain(
      locale === "en" ? "Verification: Unverified" : "未獨立核實",
    );
    expect(markup).toContain(
      locale === "en" ? "Record correction" : "記錄更正",
    );
    expect(markup).toContain("商戶 reason 原文");
    expect(markup).toContain("更正 correction 原文");
    expect(markup).toContain("1,234");
    expect(markup).toContain(locale === "en" ? "8:00" : "上午8:00");
    expect(markup).toContain("/api/listings/export/attempt-exact/download");
    for (const artifactStatus of ["pending", "failed"] as const) {
      const gated = renderToStaticMarkup(
        createElement(ExportReconciliationPanel, {
          detail: { ...detail, attempt: { ...detail.attempt, artifactStatus } },
        }),
      );
      expect(gated).not.toContain("/download");
      expect(gated).not.toContain("<form");
      expect(gated).toContain(
        locale === "en"
          ? "Download and reporting are unavailable"
          : "無法下載或回報結果",
      );
    }
  },
);
it.each(["en", "zh-Hant"] as const)(
  "localizes processing, field and evidence chrome while retaining merchant content in %s",
  (locale) => {
    preference.locale = locale;
    const processing = renderToStaticMarkup(
      createElement(ListingProcessingPanel, {
        status: "received",
        canProcess: true,
        busy: false,
        onProcess: vi.fn(),
      }),
    );
    expect(processing).toContain(
      locale === "en" ? "Processing not started" : "尚未開始處理",
    );
    expect(processing).toContain(
      locale === "en" ? "Start processing" : "開始處理",
    );
    const evidence = renderToStaticMarkup(
      createElement(EvidencePanel, {
        evidence: [
          {
            field: "title.en",
            source: "source-id-exact",
            excerpt: "商戶 evidence 原文",
            page: 12,
          },
        ],
      }),
    );
    expect(evidence).toContain(
      locale === "en" ? "Title (English)" : "商品名稱（英文）",
    );
    expect(evidence).toContain("source-id-exact");
    expect(evidence).toContain("商戶 evidence 原文");
    const fields = renderToStaticMarkup(
      createElement(ListingFieldsForm, {
        model: {
          id: "listing-exact",
          versionId: "version-exact",
          status: "in_review",
          blockingFlags: [],
          fields: [
            {
              key: "titleEn",
              label: "商品名稱（英文）",
              englishLabel: "Title (English)",
              value: "商戶 Title 原文",
              confidence: null,
              evidence: null,
            },
          ],
        },
      }),
    );
    expect(fields).toContain("商戶 Title 原文");
    expect(fields).toContain(locale === "en" ? "Save draft" : "儲存草稿");
    expect(fields).not.toContain(
      locale === "en" ? "商品欄位" : "Listing fields",
    );
    const shot = renderToStaticMarkup(
      createElement(ProductShotPanel, {
        previewUrl: "/fixture.png",
        brandBackgroundColor: null,
      }),
    );
    expect(shot).toContain(
      locale === "en" ? 'alt="Product shot preview"' : 'alt="商品照預覽"',
    );
    const delivery = renderToStaticMarkup(
      createElement(DeliveryPanel, {
        model: {
          connection: "disconnected",
          status: "approved",
          canReview: true,
          remoteProductUrl: null,
          remoteProductId: null,
          shoplineLink: { origin: "import", remoteProductId: "remote-exact" },
          listingId: "listing-exact",
          canRecordImportResult: true,
        },
      }),
    );
    expect(delivery).toContain(
      locale === "en"
        ? "Record unlinked historical result"
        : "記錄未連結的歷史結果",
    );
    expect(delivery).not.toContain(
      locale === "en" ? "Create via API" : "透過 API 建立",
    );
  },
);
it.each(["en", "zh-Hant"] as const)(
  "associates compliance validation with the exact control in %s",
  async (locale) => {
    preference.locale = locale;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const resolve = vi.fn();
    try {
      await act(async () =>
        root.render(
          createElement(ComplianceFlags, {
            flags: [
              {
                id: "flag-exact",
                code: "health_claim",
                field: "title.en",
                label: "健康功效聲稱",
                description: "描述",
                status: "open",
                resolutionReason: null,
              },
            ],
            canResolve: true,
            onResolve: resolve,
          }),
        ),
      );
      await act(async () =>
        host.querySelector<HTMLButtonElement>("button")!.click(),
      );
      const textarea = host.querySelector("textarea")!;
      const alert = host.querySelector('[role="alert"]')!;
      expect(textarea.getAttribute("aria-invalid")).toBe("true");
      expect(textarea.getAttribute("aria-describedby")).toBe(alert.id);
      expect(alert.textContent).toContain(
        locale === "en" ? "at least 10 characters" : "至少需要 10 個字元",
      );
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);
