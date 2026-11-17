import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildStudioOnboarding } from "../lib/studio/onboarding";
import { StudioOnboarding } from "./studio-onboarding";

const EMPTY = {
  connectionPresent: false,
  reviewerCount: 0,
  listingCount: 0,
  artifactCount: 0,
  signedOffCount: 0,
  exportCount: 0,
} as const;

function render(
  result: ReturnType<typeof buildStudioOnboarding>,
  locale: "zh-Hant" | "en" = "en",
) {
  return renderToStaticMarkup(
    <StudioOnboarding locale={locale} result={result} />,
  );
}

describe("StudioOnboarding", () => {
  it("renders a server-derived checklist with real links for an owner", () => {
    const html = render(buildStudioOnboarding(EMPTY, "owner"));
    expect(html).toContain("Getting started · 0 of 6 done");
    expect(html).toContain("Connect SHOPLINE");
    expect(html).toContain("Add a reviewer");
    expect(html).toContain('href="/admin"');
    expect(html).not.toContain('href="/studio/connections"');
    expect(html).toContain('href="/listings/import"');
    expect(html).toContain('href="/batches"');
    expect(html).toContain("Progress is derived from workspace records");
  });

  it("does not offer an action a viewer cannot take", () => {
    const html = render(buildStudioOnboarding(EMPTY, "viewer"));
    expect(html).not.toContain('href="/studio/connections"');
    expect(html).not.toContain('href="/admin"');
    expect(html).not.toContain('href="/listings/import"');
    expect(html).toContain("Ask an admin");
    expect(html).toContain("Ask an operator");
    expect(html).toContain("Ask a reviewer");
  });

  it("shows partial progress without estimating the unreadable source", () => {
    const result = buildStudioOnboarding(
      {
        ...EMPTY,
        listingCount: null,
        signedOffCount: 1,
      },
      "owner",
    );
    const html = render(result);
    expect(html).toContain("1 of 6 done");
    expect(html).toContain("Some setup data could not be read");
    expect(html).toContain("Unknown");
  });

  it("hides itself once every durable step is done", () => {
    const result = buildStudioOnboarding(
      {
        connectionPresent: true,
        reviewerCount: 1,
        listingCount: 1,
        artifactCount: 1,
        signedOffCount: 1,
        exportCount: 1,
      },
      "owner",
    );
    expect(render(result)).toBe("");
  });

  it("shows one honest unavailable note when every source failed", () => {
    const result = buildStudioOnboarding(
      {
        connectionPresent: null,
        reviewerCount: null,
        listingCount: null,
        artifactCount: null,
        signedOffCount: null,
        exportCount: null,
      },
      "owner",
    );
    const html = render(result);
    expect(html).toContain("Setup progress could not be read");
    expect(html).not.toContain("0 of 6");
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render(buildStudioOnboarding(EMPTY, "owner"), "zh-Hant");
    expect(html).toContain("開始使用 · 已完成 0/6");
    expect(html).toContain("連接 SHOPLINE");
  });
});
