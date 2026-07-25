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

    expect(markup).toContain("尚未開始處理 · Processing not started");
    expect(markup).toContain("開始處理 · Start processing");
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

    expect(markup).toContain("已加入處理佇列 · Queued for processing");
    expect(markup).not.toContain("Start processing");
  });

  it.each([
    ["processing", "AI 正在建立商品資料 · AI processing"],
    ["needs_info", "需要補充商品資料 · More information needed"],
  ] as const)("shows %s without a retry button", (status, copy) => {
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status={status}
        canProcess
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).toContain(copy);
    expect(markup).not.toContain("Start processing");
  });

  it("shows terminal failure recovery guidance without a retry button", () => {
    const markup = renderToStaticMarkup(
      <ListingProcessingPanel
        status="failed"
        canProcess
        onProcess={vi.fn()}
        busy={false}
      />,
    );

    expect(markup).toContain("AI 處理未完成 · Processing failed");
    expect(markup).toContain("來源檔案已保留");
    expect(markup).not.toContain("Start processing");
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
