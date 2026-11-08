import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { EvidenceCheck, EvidenceSource } from "../lib/studio/types";
import { safeStudioDeepLink, StudioEvidence } from "./studio-evidence";

const listingCheck: EvidenceCheck = {
  key: "studio.check.listing_status",
  values: {
    listingId: "listing-1",
    status: "approved",
    activeVersion: "present",
  },
  state: "ok",
};

const qualityCheck: EvidenceCheck = {
  key: "studio.check.quality_summary",
  values: {
    totalListings: 12,
    totalAssessed: 9,
    cleanCount: 7,
    hasGapsCount: 2,
    projectionState: "ready",
  },
  state: "missing",
};

function source(overrides: Partial<EvidenceSource>): EvidenceSource {
  return {
    ref: "listing:listing-1:v1",
    kind: "listing",
    label: "Synthetic listing",
    refId: "listing-1",
    version: "1",
    asOf: "2026-11-08T00:00:00.000Z",
    coverage: "present",
    deepLink: "/listings/listing-1",
    restricted: false,
    ...overrides,
  };
}

describe("safeStudioDeepLink", () => {
  it("accepts same-origin paths and http(s) URLs", () => {
    expect(safeStudioDeepLink("/quality")).toEqual({
      href: "/quality",
      external: false,
    });
    expect(safeStudioDeepLink("https://example.invalid/x")).toEqual({
      href: "https://example.invalid/x",
      external: true,
    });
    expect(safeStudioDeepLink("http://example.invalid/x")).not.toBeNull();
  });

  it("rejects protocol-relative, script, data, relative and malformed links", () => {
    for (const href of [
      "//evil.invalid/x",
      "javascript:alert(1)",
      "data:text/html,x",
      "relative/path",
      "",
      null,
      undefined,
    ]) {
      expect(safeStudioDeepLink(href), String(href)).toBeNull();
    }
  });
});

describe("StudioEvidence", () => {
  it("renders coverage chips and never turns missing into zero", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence
        locale="en"
        checks={[qualityCheck]}
        coverage={{ listing: "present", quality: "missing" }}
      />,
    );

    expect(html).toContain("From your records");
    expect(html).toContain('data-coverage="present"');
    expect(html).toContain('data-coverage="missing"');
    expect(html).toContain("Missing");
    expect(html).toContain("Missing is not zero");
    // The missing chip carries no fabricated number.
    expect(html).not.toMatch(/missing[^<]{0,40}>\s*0\s*</i);
  });

  it("renders every coverage state the reply recorded, including unsupported", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence
        locale="en"
        checks={[]}
        coverage={{
          catalog: "present",
          listing: "missing",
          quality: "unsupported",
        }}
      />,
    );
    expect(html).toContain("Present");
    expect(html).toContain("Missing");
    expect(html).toContain("Unsupported");
  });

  it("renders the check -> result table with state badges and source links", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence
        locale="en"
        checks={[listingCheck, qualityCheck]}
        coverage={{ listing: "present", quality: "missing" }}
      />,
    );

    expect(html).toContain("<table");
    expect(html).toContain("Check");
    expect(html).toContain("Result");
    expect(html).toContain("Listing listing-1: status approved");
    expect(html).toContain('href="/listings/listing-1"');
    expect(html).toContain('href="/quality"');
    expect(html).toContain("Missing");
  });

  it("escapes operator-facing check values as text", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence
        locale="en"
        checks={[
          {
            key: "studio.check.listing_status",
            values: {
              listingId: "<img src=x>",
              status: "approved",
              activeVersion: "present",
            },
            state: "ok",
          },
        ]}
        coverage={{}}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders restricted sources without content and without a link", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence
        locale="en"
        checks={[]}
        coverage={{}}
        sources={[
          source({
            restricted: true,
            label: "Synthetic restricted title",
            deepLink: "/listings/listing-1",
          }),
        ]}
      />,
    );

    expect(html).toContain("Restricted record; content is not shown.");
    expect(html).not.toContain("Synthetic restricted title");
    expect(html).not.toContain('href="/listings/listing-1"');
  });

  it("renders external sources with rel=nofollow noopener and internal sources as paths", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence
        locale="en"
        checks={[]}
        coverage={{}}
        sources={[
          source({
            ref: "external:1",
            deepLink: "https://example.invalid/report",
            label: "Synthetic external record",
          }),
          source({ ref: "internal:1" }),
        ]}
      />,
    );

    expect(html).toContain('href="https://example.invalid/report"');
    expect(html).toMatch(/rel="nofollow noopener noreferrer"/);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="/listings/listing-1"');
    expect(html).toContain("Source records");
  });

  it("drops a javascript: deep link instead of rendering an anchor", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence
        locale="en"
        checks={[]}
        coverage={{}}
        sources={[source({ deepLink: "javascript:alert(1)" })]}
      />,
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Open source");
  });

  it("says no source rows were stored instead of implying none existed", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence locale="en" checks={[]} coverage={{}} sources={[]} />,
    );
    expect(html).toContain("No source rows are stored with this reply.");
  });

  it("renders no source section when the caller has no source rows", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence locale="en" checks={[]} coverage={{}} />,
    );
    expect(html).not.toContain("Source records");
    expect(html).not.toContain("No source rows are stored");
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = renderToStaticMarkup(
      <StudioEvidence
        locale="zh-Hant"
        checks={[listingCheck]}
        coverage={{ listing: "present" }}
      />,
    );
    expect(html).toContain("來自你的記錄");
    expect(html).toContain("商品 listing-1");
  });
});
