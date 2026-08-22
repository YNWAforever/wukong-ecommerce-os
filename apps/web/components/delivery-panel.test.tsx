import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeliveryPanel, type DeliveryModel } from "./delivery-panel";

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

    expect(markup).toContain("未連接");
    expect(markup).toContain("CSV fallback");
    expect(markup).toContain("匯出 SHOPLINE CSV");
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

    expect(markup).toContain("已連接");
    expect(markup).toContain("發布至 SHOPLINE");
    expect(markup).toContain("匯出 SHOPLINE CSV");
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

    expect(markup).toContain("此操作將建立新的 SHOPLINE 商品");
    expect(markup).toContain("This will create a new SHOPLINE product");
    expect(markup).not.toContain("此操作將更新現有 SHOPLINE 商品");
  });

  it("shows an update message naming the listing's sku when shoplineLink is present", () => {
    const model: DeliveryModel = {
      connection: "connected",
      status: "approved",
      canReview: true,
      remoteProductUrl: null,
      remoteProductId: null,
      shoplineLink: { remoteProductId: "remote_existing_1" },
    };
    const markup = renderToStaticMarkup(
      <DeliveryPanel model={model} sku="OPAK-2024-RIES" />,
    );

    expect(markup).toContain(
      "此操作將更新現有 SHOPLINE 商品「OPAK-2024-RIES」",
    );
    expect(markup).toContain(
      "This will update the existing SHOPLINE product for OPAK-2024-RIES",
    );
    expect(markup).not.toContain("此操作將建立新的 SHOPLINE 商品");
  });
});
