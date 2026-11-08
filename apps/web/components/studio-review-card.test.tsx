// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  copyProposalPayloadSchema,
  StudioReviewCard,
  type StudioReviewExport,
} from "./studio-review-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    listingId: "listing-1",
    activeVersionId: "version-1",
    activeVersionSequence: 7,
    fields: [
      {
        field: "title.en",
        current: "Synthetic old title",
        proposed: "Synthetic proposed title",
        evidenceRefs: ["listing:listing-1:v7"],
      },
      {
        field: "description.zh-Hant",
        current: null,
        proposed: "合成建議描述",
        evidenceRefs: ["listing:listing-1:v7", "quality:v1"],
      },
    ],
    limitations: ["Synthetic proposal limitation"],
    asOf: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

function render(
  locale: "zh-Hant" | "en",
  value: unknown = payload(),
  exportInfo: StudioReviewExport | null = null,
) {
  return renderToStaticMarkup(
    <StudioReviewCard
      locale={locale}
      payload={value}
      exportInfo={exportInfo}
    />,
  );
}

describe("StudioReviewCard", () => {
  it("renders the current -> proposed table with raw field ids in monospace", () => {
    const html = render("en");

    expect(html).toContain("Proposed content · human approval required");
    expect(html).toContain("<table");
    expect(html).toContain("Field");
    expect(html).toContain("Current");
    expect(html).toContain("Proposed");
    expect(html).toContain("Evidence");
    expect(html).toContain("Synthetic old title");
    expect(html).toContain("Synthetic proposed title");
    // Field ids are stored ids, not prettified labels.
    expect(html).toContain("title.en");
    expect(html).toContain("description.zh-Hant");
    expect(html).toContain('<code class="');
  });

  it("renders evidence refs as non-interactive chips, never links", () => {
    const html = render("en");

    expect(html).toContain("listing:listing-1:v7");
    expect(html).toContain("quality:v1");
    // A ref is not a URL and must not be an anchor.
    expect(html).not.toMatch(/<a[^>]*>listing:listing-1:v7/);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("renders the human-approval gate and the no-canonical-write note", () => {
    const html = render("en");

    expect(html).toContain(
      "Requires human review; Studio never approves or publishes.",
    );
    expect(html).toContain("The proposal never writes canonical listing data.");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Apply");
  });

  it("links to the existing listing review screen and shows version/as-of", () => {
    const html = render("en");

    expect(html).toContain('href="/listings/listing-1"');
    expect(html).toContain("Open in the review workspace");
    expect(html).toContain("Active version 7");
    expect(html).toContain("Active version");
    expect(html).toContain("As of");
  });

  it("renders a not-provided marker for an empty current value", () => {
    const html = render("en");
    expect(html).toContain("Not provided");
    expect(html).toContain("合成建議描述");
  });

  it("renders limitations and an explicit empty-fields state", () => {
    const withLimitations = render("en");
    expect(withLimitations).toContain("Limitations");
    expect(withLimitations).toContain("Synthetic proposal limitation");

    const empty = render("en", payload({ fields: [] }));
    expect(empty).toContain("No proposed fields.");
  });

  it("renders an honest unavailable state for an invalid payload instead of crashing", () => {
    for (const invalid of [
      null,
      {},
      { ...payload(), fields: "not-an-array" },
      { ...payload(), listingId: "" },
      { ...payload(), fields: [{ field: "title.en" }] },
    ]) {
      const html = render("en", invalid);
      expect(html).toContain(
        "This proposal could not be displayed; nothing is invented.",
      );
      expect(html).not.toContain("<table");
    }
  });

  it("parses the reviewed payload contract", () => {
    expect(copyProposalPayloadSchema.safeParse(payload()).success).toBe(true);
    expect(
      copyProposalPayloadSchema.safeParse({
        ...payload(),
        activeVersionSequence: 7.5,
      }).success,
    ).toBe(false);
    expect(
      copyProposalPayloadSchema.safeParse({ ...payload(), asOf: "" }).success,
    ).toBe(false);
  });

  it("escapes proposed text as text, not markup", () => {
    const html = render(
      "en",
      payload({
        fields: [
          {
            field: "title.en",
            current: "old",
            proposed: "<img src=x onerror=alert(1)>",
            evidenceRefs: ["listing:listing-1:v7"],
          },
        ],
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render("zh-Hant");

    expect(html).toContain("建議內容 · 須人工審核");
    expect(html).toContain("欄位");
    expect(html).toContain("目前");
    expect(html).toContain("建議");
    expect(html).toContain("須由人員審核；工作室不會批准或發佈。");
    expect(html).toContain("建議內容不會寫入正式商品資料。");
    expect(html).toContain("在審核畫面開啟");
  });

  it("states the not-applied state and disables exports without a saved artifact", () => {
    const html = render("en");

    expect(html).toContain("Not applied — apply only in the review screen.");
    expect(html).toContain("Download JSON");
    expect(html).toContain("Download PDF");
    expect(html).toContain("Save before exporting.");
    // No export anchor exists until the artifact is saved/signed off.
    expect(html).not.toContain("/export?digest=");
    expect(html).not.toContain("Only a saved or signed-off artifact");
  });

  it("enables JSON and PDF exports with the latest digest for saved/signed-off artifacts", () => {
    const digest = "b".repeat(64);
    const saved = render("en", payload(), {
      outputId: "output-1",
      status: "saved",
      digest,
    });
    expect(saved).toContain(
      `/api/studio/outputs/output-1/export?digest=${digest}&amp;format=json`,
    );
    expect(saved).toContain(
      `/api/studio/outputs/output-1/export?digest=${digest}&amp;format=pdf`,
    );
    expect(saved).toContain(
      "Only a saved or signed-off artifact can be exported.",
    );
    // The review link now carries the handoff parameter.
    expect(saved).toContain('href="/listings/listing-1?studioOutput=output-1"');

    const signedOff = render("en", payload(), {
      outputId: "output-1",
      status: "signed_off",
      digest,
    });
    expect(signedOff).toContain(`&amp;format=pdf`);

    const draft = render("en", payload(), {
      outputId: "output-1",
      status: "draft",
      digest,
    });
    expect(draft).not.toContain("/export?digest=");
    expect(draft).toContain("Save before exporting.");
  });

  const roots: ReturnType<typeof createRoot>[] = [];

  async function mountClipboardCard(
    exportInfo: StudioReviewExport | null = null,
  ) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <StudioReviewCard
          locale="en"
          payload={payload()}
          exportInfo={exportInfo}
        />,
      );
    });
    return container;
  }

  function buttons(container: HTMLElement, text: string) {
    return Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === text,
    ) as HTMLButtonElement[];
  }

  function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  it("copies one proposed field and all proposed values as printable text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const container = await mountClipboardCard();

    const fieldButtons = buttons(container, "Copy proposed");
    expect(fieldButtons.length).toBe(2);
    await act(async () => fieldButtons[0]?.click());
    expect(writeText).toHaveBeenLastCalledWith("Synthetic proposed title");
    expect(container.textContent).toContain("Copied");

    await act(async () =>
      buttons(container, "Copy all proposed values")[0]?.click(),
    );
    expect(writeText).toHaveBeenLastCalledWith(
      [
        "title.en: Synthetic proposed title",
        "description.zh-Hant: 合成建議描述",
      ].join("\n"),
    );
  });

  it("reports a clipboard refusal honestly instead of claiming success", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);
    const container = await mountClipboardCard();

    await act(async () => buttons(container, "Copy proposed")[0]?.click());
    expect(container.textContent).toContain("Could not copy to the clipboard.");
    expect(container.textContent).not.toContain("Copied");
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });
});
