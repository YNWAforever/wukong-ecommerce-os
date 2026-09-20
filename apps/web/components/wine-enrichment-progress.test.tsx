import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { WineEnrichmentProgress } from "./wine-enrichment-progress";
import { progress } from "./wine-ui-test-fixtures";
it("renders persisted stage and unknown accounting without an invented percentage", () => {
  const html = renderToStaticMarkup(
    <WineEnrichmentProgress progress={progress} />,
  );
  expect(html).toContain('data-stage="verification"');
  expect(html).toContain('aria-current="step"');
  expect(html).toContain("Unknown");
  expect(html).not.toContain("progressbar");
});
it("labels historical adoption separately from current version", () => {
  const html = renderToStaticMarkup(
    <WineEnrichmentProgress
      progress={{
        ...progress,
        state: "adopted",
        adoptedVersionId: "historical",
      }}
    />,
  );
  expect(html).toContain("historical");
  expect(html).toContain("Historical");
});

const locale = vi.hoisted(() => ({ value: "en" as "en" | "zh-Hant" }));
vi.mock("../lib/locale-context", () => ({ useLocale: () => locale.value }));
it("shows a human issue explanation without raw source identifiers or diagnostic codes", () => {
  const sourceId = "9c227a09-7777-4444-8888-92d8f6606731";
  const html = renderToStaticMarkup(
    <WineEnrichmentProgress
      progress={{
        ...progress,
        issues: [
          {
            path: `sources.${sourceId}.identity`,
            code: "source_identity_unresolved",
            blocking: false,
            evidenceIds: [sourceId],
          },
        ],
      }}
    />,
  );
  expect(html).toContain(
    "A source could not be matched to this product. Compare the source details before using its claims.",
  );
  expect(html).toContain("(notice)");
  expect(html).not.toContain(sourceId);
  expect(html).not.toContain("source_identity_unresolved");
});
it("keeps unknown blocking issues actionable without displaying provider diagnostic text", () => {
  const html = renderToStaticMarkup(
    <WineEnrichmentProgress
      progress={{
        ...progress,
        issues: [
          {
            path: "private.internal.path",
            code: "unexpected_private_diagnostic",
            blocking: true,
            evidenceIds: [],
          },
        ],
      }}
    />,
  );
  expect(html).toContain(
    "Review the saved evidence and product details before continuing.",
  );
  expect(html).toContain("(needs attention)");
  expect(html).not.toContain("unexpected_private_diagnostic");
  expect(html).not.toContain("private.internal.path");
});

it("keeps localized Chinese issue severity and hides technical identifiers", () => {
  locale.value = "zh-Hant";
  try {
    const html = renderToStaticMarkup(
      <WineEnrichmentProgress
        progress={{
          ...progress,
          issues: [
            {
              path: "sources.private-id.identity",
              code: "source_identity_unresolved",
              blocking: true,
              evidenceIds: [],
            },
          ],
        }}
      />,
    );
    expect(html).toContain("\u672a\u80fd\u78ba\u8a8d");
    expect(html).toContain("\u9700\u8655\u7406");
    expect(html).not.toContain("private-id");
    expect(html).not.toContain("source_identity_unresolved");
  } finally {
    locale.value = "en";
  }
});
