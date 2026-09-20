import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { WineEvidencePanel } from "./wine-evidence-panel";
it("keeps original excerpt and source metadata without inventing unavailable links", () => {
  const html = renderToStaticMarkup(
    <WineEvidencePanel
      evidence={[
        {
          id: "source",
          kind: "web",
          title: "Producer",
          excerpt: "Original source words",
          url: null,
          linkStatus: "unavailable",
          contentScope: "snippet",
          capturedAt: "2026-09-20T00:00:00Z",
          truncated: true,
        },
      ]}
    />,
  );
  expect(html).toContain("Original source words");
  expect(html).toContain("2026-09-20");
  expect(html).toContain("snippet");
  expect(html).toContain("Truncated");
  expect(html).not.toContain("href=");
});
it("opens admitted documents safely and labels human identity choices", () => {
  const html = renderToStaticMarkup(
    <WineEvidencePanel
      evidence={[
        {
          id: "source",
          kind: "merchant",
          title: "Merchant identity selection (not observed evidence)",
          excerpt: "Selected 2020",
          url: null,
          linkStatus: "not_applicable",
          contentScope: "note",
          capturedAt: "2026-09-20",
          truncated: false,
        },
        {
          id: "web",
          kind: "web",
          title: "Producer",
          excerpt: "Evidence",
          url: "https://producer.test/wine",
          linkStatus: "available",
          contentScope: "document",
          capturedAt: "2026-09-20",
          truncated: false,
        },
      ]}
    />,
  );
  expect(html).toContain("Operator confirmation");
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('href="https://producer.test/wine"');
});

vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
