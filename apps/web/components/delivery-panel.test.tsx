import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DeliveryPanel, type DeliveryModel } from "./delivery-panel";
import { ImportResultHistory } from "./import-result-form";

describe("DeliveryPanel", () => {
  it("labels CSV as fallback when SHOPLINE is disconnected", () => {
    const model: DeliveryModel = {
      connection: "disconnected",
      status: "approved",
      canReview: true,
      remoteProductUrl: null,
      remoteProductId: null,
      shoplineLink: null,
    };
    const markup = renderToStaticMarkup(<DeliveryPanel model={model} />);

    expect(markup).toContain("Not connected");
    expect(markup).toContain("CSV fallback");
    expect(markup).toContain("Create CSV");
    expect(markup).not.toContain("連接 SHOPLINE");
    expect(markup).not.toContain("remote.example");
  });

  it("shows the stored SHOPLINE product id after publishing", () => {
    const model = {
      connection: "connected",
      status: "published",
      canReview: true,
      remoteProductUrl: null,
      remoteProductId: "remote_opak_e2e_123",
      shoplineLink: null,
    } satisfies DeliveryModel;

    const markup = renderToStaticMarkup(<DeliveryPanel model={model} />);

    expect(markup).toContain("SHOPLINE product ID");
    expect(markup).toContain("remote_opak_e2e_123");
  });
  it("enables API and CSV delivery only for an approved connected listing", () => {
    const model: DeliveryModel = {
      connection: "connected",
      status: "approved",
      canReview: true,
      remoteProductUrl: null,
      remoteProductId: null,
      shoplineLink: null,
    };
    const markup = renderToStaticMarkup(<DeliveryPanel model={model} />);

    expect(markup).toContain("Connected");
    expect(markup).toContain("Create via API");
    expect(markup).toContain("Create CSV");
    expect(markup).toContain("Create via API");
    expect(markup).toContain("Create CSV");
    expect(markup).not.toContain('disabled=""');
  });

  it("shows a create message when shoplineLink is null", () => {
    const model: DeliveryModel = {
      connection: "connected",
      status: "approved",
      canReview: true,
      remoteProductUrl: null,
      remoteProductId: null,
      shoplineLink: null,
    };
    const markup = renderToStaticMarkup(
      <DeliveryPanel model={model} sku={null} />,
    );

    expect(markup).toContain("This will create a new SHOPLINE product");
    expect(markup).toContain("This will create a new SHOPLINE product");
    expect(markup).not.toContain(
      "This will update the existing SHOPLINE product",
    );
  });

  it("shows an update message naming the listing's sku when shoplineLink is present", () => {
    const model: DeliveryModel = {
      connection: "connected",
      status: "approved",
      canReview: true,
      remoteProductUrl: null,
      remoteProductId: null,
      shoplineLink: { remoteProductId: "remote_existing_1", origin: "created" },
    };
    const markup = renderToStaticMarkup(
      <DeliveryPanel model={model} sku="OPAK-2024-RIES" />,
    );

    expect(markup).toContain(
      "This will update the existing SHOPLINE product (OPAK-2024-RIES)",
    );
    expect(markup).toContain(
      "This will update the existing SHOPLINE product (OPAK-2024-RIES)",
    );
    expect(markup).not.toContain("This will create a new SHOPLINE product");
  });
  it("separates imported Bulk Update from created-origin Create CSV and API delivery", () => {
    const imported = renderToStaticMarkup(
      <DeliveryPanel
        model={{
          connection: "connected",
          status: "approved",
          canReview: true,
          remoteProductUrl: null,
          remoteProductId: null,
          listingId: "listing-1",
          versionId: "version-1",
          canRecordImportResult: true,
          shoplineLink: { remoteProductId: "remote-1", origin: "import" },
        }}
        sku="SKU-1"
      />,
    );
    expect(imported).toContain("Generate Bulk Update XLSX");
    expect(imported).not.toContain("Create via API");
    expect(imported).not.toContain("Create CSV");
    expect(imported).not.toContain("Create via API");
    expect(imported).not.toContain("Create CSV");
    expect(imported).toContain("Record unlinked historical result");
    const created = renderToStaticMarkup(
      <DeliveryPanel
        model={{
          connection: "connected",
          status: "approved",
          canReview: true,
          remoteProductUrl: null,
          remoteProductId: null,
          listingId: "listing-2",
          shoplineLink: { remoteProductId: "remote-2", origin: "created" },
        }}
      />,
    );
    expect(created).toContain("Create CSV / API");
    expect(created).toContain("Update via API");
    expect(created).toContain("Create CSV");
    expect(created).not.toContain("Generate Bulk Update XLSX");
  });
  it("shows rejection and correction reasons in manual result history", () => {
    const markup = renderToStaticMarkup(
      <ImportResultHistory
        label="Manual correction history"
        results={[
          {
            id: "manual-2",
            outcome: "rejected",
            rejectReason: "SHOPLINE validation failed",
            correctionReason: "Corrected prior report",
            revision: 2,
            createdAt: "2026-01-02T00:00:00Z",
          },
        ]}
      />,
    );
    expect(markup).toContain("Manual correction history");
    expect(markup).toContain("Rejection reason: SHOPLINE validation failed");
    expect(markup).toContain("Correction reason: Corrected prior report");
  });
});

// Exercise the selected locale explicitly; bilingual coverage lives in listing-detail-locale.test.tsx.
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
