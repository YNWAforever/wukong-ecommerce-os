import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StudioToday } from "./studio-today";
import type { StudioInboxResult } from "../lib/studio/contracts";

const AS_OF = "2026-11-17T00:00:00.000Z";

function inbox(
  overrides: Partial<{
    counts: Partial<
      Record<
        StudioInboxResult["needsAttention"]["items"][number]["key"],
        number | null
      >
    >;
    jobs: StudioInboxResult["jobs"]["items"];
    unavailable: boolean;
  }> = {},
): StudioInboxResult {
  const counts = {
    listings_awaiting_review: 4,
    listings_with_gaps: 2,
    listings_without_active_version: 0,
    unassessable_active_version: 0,
    ...overrides.counts,
  };
  return {
    asOf: AS_OF,
    needsAttention: {
      items: [
        {
          key: "listings_with_gaps",
          count: counts.listings_with_gaps,
          deepLink: "/quality",
        },
        {
          key: "listings_without_active_version",
          count: counts.listings_without_active_version,
          deepLink: "/quality",
        },
        {
          key: "unassessable_active_version",
          count: counts.unassessable_active_version,
          deepLink: "/quality",
        },
        {
          key: "listings_awaiting_review",
          count: counts.listings_awaiting_review,
          deepLink: "/dashboard",
        },
      ],
      unavailable: overrides.unavailable ?? false,
      deepLink: "/quality",
    },
    jobs: {
      items: overrides.jobs ?? [],
      truncated: false,
      unavailable: false,
      deepLink: "/jobs",
    },
    outputs: {
      items: [],
      truncated: false,
      unavailable: false,
      deepLink: "/studio/outputs",
    },
    conversations: {
      items: [],
      truncated: false,
      unavailable: false,
      deepLink: "/studio/threads",
    },
  };
}

describe("StudioToday", () => {
  it("renders the queue in priority order with owner and action", () => {
    const html = renderToStaticMarkup(
      <StudioToday locale="en" inbox={inbox()} showHowTo />,
    );

    expect(html).toContain("Today");
    expect(html).toContain("4 listing(s) waiting for review or intake");
    expect(html).toContain("2 listing(s) with quality gaps");
    expect(html.indexOf("waiting for review")).toBeLessThan(
      html.indexOf("quality gaps"),
    );
    expect(html).toContain("Operator");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('href="/quality"');
    expect(html).toContain("Open workbench");
    expect(html).toContain("How this works");
    expect(html).toContain("Start a guided review from a listing");
  });

  it("renders the honest empty state when there is no work", () => {
    const html = renderToStaticMarkup(
      <StudioToday
        locale="en"
        inbox={inbox({
          counts: {
            listings_awaiting_review: 0,
            listings_with_gaps: 0,
            listings_without_active_version: 0,
            unassessable_active_version: 0,
          },
        })}
      />,
    );

    expect(html).toContain("Nothing needs your attention right now.");
    expect(html).not.toContain("waiting for review");
  });

  it("says the queue could not be read instead of showing an empty list", () => {
    const html = renderToStaticMarkup(<StudioToday locale="en" inbox={null} />);

    expect(html).toContain("The work queue could not be read");
    expect(html).not.toContain("Nothing needs your attention");
  });

  it("bounds the home list and links to the inbox for the rest", () => {
    const html = renderToStaticMarkup(
      <StudioToday locale="en" inbox={inbox()} limit={1} />,
    );

    expect(html).toContain('data-kind="review"');
    expect(html).not.toContain('data-kind="gaps"');
    expect(html).toContain("And 1 more");
    expect(html).toContain('href="/studio/inbox"');
  });

  it("renders the zh-Hant queue title and owner label", () => {
    const html = renderToStaticMarkup(
      <StudioToday
        locale="zh-Hant"
        inbox={inbox()}
        titleKey="studio.inbox.queueTitle"
      />,
    );

    expect(html).toContain("優先處理");
    expect(html).toContain("操作員");
    expect(html).toContain("4 個商品等待處理或審核");
  });
});
