// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioRunDetails } from "./studio-run-details";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const RUN = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
function detail(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN,
    threadId: THREAD,
    status: "succeeded",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    inputTokens: 927,
    outputTokens: 1385,
    settledUsd: "0.001941",
    reservation: {
      state: "settled",
      pricingVersion: "go-v1",
      reservedUsd: "0.638976",
      settledUsd: "0.001941",
    },
    ...overrides,
  };
}
const mounted: Array<{
  root: ReturnType<typeof createRoot>;
  host: HTMLDivElement;
}> = [];
async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(<StudioRunDetails locale="en" threadId={THREAD} runId={RUN} />);
  });
  return { root, host };
}
async function load(host: HTMLElement) {
  await act(async () => {
    host.querySelector<HTMLButtonElement>("button")!.click();
  });
}
function value(host: HTMLElement, label: string) {
  return [...host.querySelectorAll("dt")].find((e) => e.textContent === label)
    ?.nextElementSibling?.textContent;
}
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StudioRunDetails", () => {
  it("loads on demand and shows the persisted model, cost and ledger reservation", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(detail()));
    vi.stubGlobal("fetch", fetcher);
    const { host } = await mount();
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => {
      const details = host.querySelector("details")!;
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/api/studio/threads/${THREAD}/runs/${RUN}`,
    );
    expect(value(host, "Model")).toBe("deepseek-v4.1-flash");
    expect(value(host, "Input tokens")).toBe("927");
    expect(value(host, "Recorded cost (USD)")).toBe("0.001941");
    expect(value(host, "Original reservation (USD)")).toBe("0.638976");
    expect(value(host, "Budget reservation state")).toBe("Settled");
  });

  it("keeps unknown usage and an uncertain reservation distinct from zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          detail({
            provider: null,
            model: null,
            inputTokens: null,
            outputTokens: null,
            settledUsd: null,
            reservation: {
              state: "uncertain",
              pricingVersion: "go-v1",
              reservedUsd: "0.638976",
              settledUsd: null,
            },
          }),
        ),
      ),
    );
    const { host } = await mount();
    await load(host);
    expect(value(host, "Model")).toBe("Not recorded");
    expect(value(host, "Input tokens")).toBe("Not recorded");
    expect(value(host, "Recorded cost (USD)")).toBe("Not recorded");
    expect(value(host, "Budget reservation state")).toBe(
      "Uncertain; reservation retained",
    );
    expect(value(host, "Original reservation (USD)")).toBe("0.638976");
  });

  it("renders actual zero usage and cost without treating them as missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          detail({
            inputTokens: 0,
            outputTokens: 0,
            settledUsd: "0.000000",
            reservation: null,
          }),
        ),
      ),
    );
    const { host } = await mount();
    await load(host);
    expect(value(host, "Input tokens")).toBe("0");
    expect(value(host, "Recorded cost (USD)")).toBe("0.000000");
    expect(value(host, "Budget reservation state")).toBe(
      "No budget reservation",
    );
  });

  it("shows a safe retryable error and does not render a response for another run", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(detail({ runId: OTHER, model: "foreign-model" })),
      )
      .mockResolvedValueOnce(Response.json(detail()));
    vi.stubGlobal("fetch", fetcher);
    const { host } = await mount();
    await load(host);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load run details",
    );
    expect(host.textContent).not.toContain("foreign-model");
    await load(host);
    expect(value(host, "Model")).toBe("deepseek-v4.1-flash");
  });

  it("aborts old context reads and ignores their late completion", async () => {
    let resolveOld!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json(detail({ runId: OTHER, model: "current-model" })),
      );
    vi.stubGlobal("fetch", fetcher);
    const { root, host } = await mount();
    await load(host);
    const oldSignal = fetcher.mock.calls[0]?.[1]?.signal as AbortSignal;
    await act(async () => {
      root.render(
        <StudioRunDetails locale="en" threadId={THREAD} runId={OTHER} />,
      );
    });
    expect(oldSignal.aborted).toBe(true);
    expect(host.textContent).not.toContain("deepseek-v4.1-flash");
    await load(host);
    await act(async () => {
      resolveOld(Response.json(detail()));
    });
    expect(value(host, "Model")).toBe("current-model");
  });

  it("does not display raw server errors or invent a reservation on legacy responses", async () => {
    const legacy = detail({ provider: null, model: null });
    delete (legacy as Record<string, unknown>).reservation;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("DO_NOT_RENDER", { status: 503 }))
        .mockResolvedValueOnce(Response.json(legacy)),
    );
    const { host } = await mount();
    await load(host);
    expect(host.textContent).not.toContain("DO_NOT_RENDER");
    await load(host);
    expect(value(host, "Model provider")).toBe("Not recorded");
    expect(value(host, "Budget reservation state")).toBe("Not recorded");
  });
});
