import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ListingProcessingPanel } from "./listing-processing-panel.js";

describe("ListingProcessingPanel", () => {
  it("offers processing recovery for a received listing when enqueue failed", () => {
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status="received"
        enqueueState="retry_required"
        canProcess
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).toContain("Processing not started");
    expect(markup).toContain("Start processing");
  });

  it("offers processing when a received listing has no known enqueue outcome", () => {
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status="received"
        canProcess
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).toContain("Start processing");
  });

  it("shows queued received listings without a retry button", () => {
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status="received"
        enqueueState="queued"
        canProcess
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).toContain("Queued for processing");
    expect(markup).not.toContain("Start processing");
  });

  it("shows a processing listing without any action", () => {
    // A delivery is mid-flight; there is nothing useful to press.
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status="processing"
        canProcess
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).toContain("AI processing");
    expect(markup).not.toContain("Start processing");
    expect(markup).not.toContain("Run processing again");
  });

  it("offers a re-run once a listing has asked for more information", () => {
    // The route now numbers this as a new run rather than answering 409, so
    // supplying the missing details can actually produce a new result.
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status="needs_info"
        canProcess
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).toContain("More information needed");
    expect(markup).toContain("Run processing again");
  });

  it("offers a retry for a failed listing, which the server accepts", () => {
    // POST /api/listings/[id]/process lists `failed` as retryable and calls
    // pipelineRuns.reopenFailed first, so this button is a real action rather
    // than one that 409s. Before this, a failed listing was a dead end whose
    // only on-screen guidance was to contact support.
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status="failed"
        canProcess
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).toContain("Processing did not finish");
    expect(markup).toContain("nothing was overwritten");
    expect(markup).toContain("Run processing again");
  });

  it("withholds the retry from a viewer who cannot process", () => {
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status="failed"
        canProcess={false}
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).toContain("Processing did not finish");
    expect(markup).not.toContain("Run processing again");
  });

  it("does not expose the action to viewers", () => {
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status="received"
        enqueueState="retry_required"
        canProcess={false}
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).not.toContain("Start processing");
  });
});

// Exercise the selected locale explicitly; bilingual coverage lives in listing-detail-locale.test.tsx.
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
