// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioGuidedJourney } from "./studio-guided-journey";
import type { StudioMessageResponse } from "../lib/studio/contracts";
import type { GuidedScope } from "../lib/studio/guided-contracts";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const ID = "11111111-1111-4111-8111-111111111111",
  VERSION = "22222222-2222-4222-8222-222222222222",
  OUTPUT = "33333333-3333-4333-8333-333333333333",
  RUN = "44444444-4444-4444-8444-444444444444",
  THREAD = "55555555-5555-4555-8555-555555555555";
const DIGEST = "a".repeat(64);
vi.mock("./studio-output-card", () => ({
  StudioOutputCard: ({ outputId }: { outputId: string }) => (
    <div data-recovered-output={outputId} />
  ),
}));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
function scope(stage: GuidedScope["stage"] = "audit"): GuidedScope {
  return {
    schemaVersion: "wukong-listing-improvement/v1",
    rootRunId: RUN,
    stage,
    listing: {
      listingId: ID,
      activeVersionId: VERSION,
      activeVersionSequence: 1,
    },
    parent:
      stage === "audit"
        ? null
        : { sourceOutputId: OUTPUT, sourceRevision: 1, sourceDigest: DIGEST },
    quality:
      stage === "audit"
        ? null
        : { assessmentVersion: "v1", gapsDigest: "b".repeat(64) },
  };
}
function messages(
  stage: GuidedScope["stage"] = "audit",
  produced = true,
): StudioMessageResponse[] {
  const action =
    stage === "audit"
      ? { kind: "audit", listingId: ID, expectedActiveVersionId: VERSION }
      : {
          kind: stage,
          sourceOutputId: OUTPUT,
          sourceRevision: 1,
          sourceDigest: DIGEST,
        };
  const op: StudioMessageResponse = {
    messageId: "operator",
    sequence: 1,
    role: "operator",
    content: {
      text: "Synthetic guided request",
      locale: "en",
      guidedAction: action,
    },
    clientMessageId: "request",
    runId: null,
    createdBy: "actor",
    createdAt: "2026-11-14T08:00:00Z",
  };
  return produced
    ? [
        op,
        {
          ...op,
          messageId: "assistant",
          sequence: 2,
          role: "assistant",
          clientMessageId: null,
          runId: RUN,
          content: {
            status: "answered",
            skillKey:
              stage === "audit"
                ? "merchant.audit"
                : stage === "gap_review"
                  ? "catalog.gap_review"
                  : "listing.copy_proposal",
            skillVersion: "1.1.0",
            records: { sections: [], checks: [], coverage: {} },
            outputs: [{ outputId: OUTPUT, revision: 1 }],
            dispatch: null,
            analysis: null,
            traceSummary: { stepCount: 1 },
            limitations: [],
            followUps: [],
          },
        },
      ]
    : [op];
}
function detail(stage: GuidedScope["stage"] = "audit") {
  return {
    output: {
      outputId: OUTPUT,
      threadId: THREAD,
      kind:
        stage === "audit"
          ? "merchant_audit"
          : stage === "gap_review"
            ? "gap_report"
            : "copy_proposal",
      currentVersion: 1,
      status: "draft",
      freshness: "current",
      confirmation: null as null | {
        status: string;
        revision: number;
        contentDigest: string;
      },
    },
    versions: [
      {
        revision: 1,
        contentDigest: DIGEST,
        scope: { guidedReview: scope(stage) },
      },
    ],
  };
}
async function mount(
  props: Partial<Parameters<typeof StudioGuidedJourney>[0]> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onPrepare = vi.fn(),
    onReload = vi.fn();
  await act(async () => {
    root.render(
      <StudioGuidedJourney
        locale="en"
        threadId={THREAD}
        messages={messages()}
        canSend
        aiEnabled
        blocked={false}
        onPrepare={onPrepare}
        onReload={onReload}
        {...props}
      />,
    );
  });
  return { container, onPrepare, onReload };
}
function button(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === text,
  );
}

describe("guided journey", () => {
  it("loads recorded progress with GET and only prepares the next request on click", async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(detail())),
    );
    vi.stubGlobal("fetch", fetch);
    const ui = await mount();
    const next = button(ui.container, "Prepare gap review")!;
    await act(async () => next.click());
    expect(ui.onPrepare).toHaveBeenCalledWith({
      kind: "gap_review",
      sourceOutputId: OUTPUT,
      sourceRevision: 1,
      sourceDigest: DIGEST,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toContain("/api/studio/outputs/");
    expect(ui.container.textContent).toContain(
      "Canonical listing data stays unchanged",
    );
  });
  it.each([{ blocked: true }, { canSend: false }])(
    "protects drafts and readonly roles: %j",
    async (props) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(detail()))),
      );
      const ui = await mount(props);
      expect(button(ui.container, "Prepare gap review")?.disabled).toBe(true);
      await act(async () =>
        button(ui.container, "Prepare gap review")?.click(),
      );
      expect(ui.onPrepare).not.toHaveBeenCalled();
    },
  );
  it.each(["stale", "unavailable"])("blocks %s evidence", async (freshness) => {
    const value = detail();
    value.output.freshness = freshness;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(value))),
    );
    const ui = await mount();
    expect(button(ui.container, "Prepare gap review")).toBeUndefined();
    expect(ui.container.textContent).toContain(
      "quality evidence changed or is unavailable",
    );
  });
  it("does not follow a newer output version", async () => {
    const value = detail();
    value.output.currentVersion = 2;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(value))),
    );
    const ui = await mount();
    expect(button(ui.container, "Prepare gap review")).toBeUndefined();
  });
  it("keeps an in-flight copy request readonly after reload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(detail("gap_review")))),
    );
    const ui = await mount({
      messages: messages("copy_proposal", false),
      attempt: { clientMessageId: "request", runId: RUN, status: "running" },
    });
    expect(button(ui.container, "Prepare another attempt")?.disabled).toBe(
      true,
    );
    expect(ui.container.textContent).toContain(
      "recorded attempt needs checking",
    );
    await act(async () =>
      button(ui.container, "Refresh journey status")?.click(),
    );
    expect(ui.onReload).toHaveBeenCalledTimes(1);
    expect(ui.onPrepare).not.toHaveBeenCalled();
  });
  it("recovers a paid artifact after a lost reply without preparing another model request", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(detail("copy_proposal"))),
    );
    vi.stubGlobal("fetch", fetcher);
    const ui = await mount({
      messages: messages("copy_proposal", false),
      attempt: {
        clientMessageId: "request",
        runId: RUN,
        status: "failed",
        reservationState: "settled",
        artifacts: [{ outputId: OUTPUT, revision: 1, contentDigest: DIGEST }],
      },
    });
    expect(
      ui.container
        .querySelector("[data-recovered-output]")
        ?.getAttribute("data-recovered-output"),
    ).toBe(OUTPUT);
    expect(ui.container.textContent).toContain(
      "Recovered the recorded artifact",
    );
    expect(button(ui.container, "Prepare another attempt")).toBeUndefined();
    expect(ui.onPrepare).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not treat a partial reply with an uncertain hold as safely retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(detail("gap_review")))),
    );
    const rows = messages("copy_proposal");
    rows[1]!.content = { ...rows[1]!.content, status: "partial", outputs: [] };
    const ui = await mount({
      messages: rows,
      attempt: {
        clientMessageId: "request",
        runId: RUN,
        status: "succeeded",
        reservationState: "uncertain",
      },
    });
    expect(button(ui.container, "Prepare another attempt")?.disabled).toBe(
      true,
    );
    expect(ui.container.textContent).toContain(
      "recorded attempt needs checking",
    );
    expect(ui.onPrepare).not.toHaveBeenCalled();
  });
  it("blocks copy when AI is disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(detail("gap_review")))),
    );
    const ui = await mount({
      messages: messages("gap_review"),
      aiEnabled: false,
    });
    expect(button(ui.container, "Prepare copy proposal")?.disabled).toBe(true);
    expect(ui.container.textContent).toContain("configured AI");
  });
  it("requires confirmation for exact handoff and emits a fully pinned link", async () => {
    const value = detail("copy_proposal");
    value.output.status = "signed_off";
    const fetch = vi.fn(async () => new Response(JSON.stringify(value)));
    vi.stubGlobal("fetch", fetch);
    const ui = await mount({ messages: messages("copy_proposal") });
    expect(ui.container.querySelector('a[href*="studioOutput"]')).toBeNull();
    value.output.confirmation = {
      status: "signed_off",
      revision: 1,
      contentDigest: DIGEST,
    };
    await act(async () =>
      button(ui.container, "Refresh journey status")?.click(),
    );
    const link = ui.container.querySelector<HTMLAnchorElement>(
      'a[href*="studioOutput"]',
    );
    expect(link?.getAttribute("href")).toBe(
      `/listings/${ID}?studioOutput=${OUTPUT}&studioRevision=1&studioDigest=${DIGEST}`,
    );
  });
});
