// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  StudioProductShotHandoff,
  stateLabel,
} from "./studio-product-shot-handoff";
import type { ProductShotHandoff } from "../lib/studio/types";

/**
 * Read-only product-shot prepare card (C1 v1.1): it shows the prepared handoff
 * (usable source images, persisted review state) and links to the existing
 * gated screen. It must never offer a confirmation that writes, claim the
 * provider was called, or print a signed URL.
 */

const handoff: ProductShotHandoff = {
  kind: "product_shot_handoff",
  listingId: "22222222-2222-4222-8222-222222222222",
  assetIds: [
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ],
  state: "candidate_ready",
  ready: true,
};

function render(locale: "zh-Hant" | "en" = "en", value = handoff): string {
  return renderToStaticMarkup(
    <StudioProductShotHandoff locale={locale} dispatch={value} />,
  );
}

describe("StudioProductShotHandoff", () => {
  it("shows the prepared source count, review state and a link to the existing screen", () => {
    const html = render("en");
    expect(html).toContain("Product-shot preparation");
    expect(html).toContain("Usable source images: 2");
    expect(html).toContain("Candidate ready for review");
    expect(html).toContain("Handoff is ready");
    expect(html).toContain(
      'href="/listings/22222222-2222-4222-8222-222222222222"',
    );
    expect(html).toContain('data-kind="product_shot_handoff"');
    expect(html).toContain('data-ready="true"');
  });

  it("never offers a writing confirmation or claims the provider ran", () => {
    const html = render("en");
    expect(html).not.toContain("Review and confirm");
    expect(html).not.toContain("signed");
    expect(html).not.toContain("Photoroom");
    expect(html).toContain("this card sends no request");
  });

  it("renders the Traditional Chinese labels", () => {
    const html = render("zh-Hant");
    expect(html).toContain("產品圖片準備");
    expect(html).toContain("可用來源圖片：2 張");
    expect(html).toContain("候選圖待審核");
    expect(html).toContain("開啟圖片審核");
  });

  it("honestly renders an unknown state and a not-ready handoff", () => {
    const html = render("en", {
      ...handoff,
      assetIds: [],
      state: null,
      ready: false,
    });
    expect(html).toContain("Unknown");
    expect(html).toContain("Handoff is not ready");
    expect(html).toContain('data-ready="false"');
  });

  it("falls back to the raw state for a state outside the reviewed set", () => {
    expect(stateLabel("en", "future_state")).toBe("future_state");
    expect(stateLabel("en", "queued")).toBe("Queued");
    expect(stateLabel("en", null)).toBe("Unknown");
  });

  it("escapes a hostile listing id instead of emitting markup", () => {
    const html = render("en", {
      ...handoff,
      listingId: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain(
      'href="/listings/%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E"',
    );
  });
});
