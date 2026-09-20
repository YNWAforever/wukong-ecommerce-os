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

vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
