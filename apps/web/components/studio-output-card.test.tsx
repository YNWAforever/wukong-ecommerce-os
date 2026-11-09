// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioOutputCard } from "./studio-output-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const proposalPayload = {
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
  ],
  limitations: [],
  asOf: "2026-11-08T00:00:00.000Z",
};

function detailBody(status: "draft" | "saved" | "signed_off" = "draft") {
  return {
    output: {
      outputId: "output-1",
      kind: "copy_proposal",
      title: "Synthetic copy proposal",
      status,
      currentVersion: 1,
      threadId: "thread-1",
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z",
    },
    versions: [
      {
        revision: 1,
        payload: proposalPayload,
        contentDigest: `${"a".repeat(64)}`,
        asOf: "2026-11-08T00:00:00.000Z",
        scope: { listingId: "listing-1" },
        createdBy: "studio",
        createdAt: "2026-11-08T00:00:00.000Z",
      },
    ],
  };
}

const roots: ReturnType<typeof createRoot>[] = [];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(
  props: Partial<Parameters<typeof StudioOutputCard>[0]> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <StudioOutputCard
        locale="en"
        outputId="output-1"
        canSignOff
        {...props}
      />,
    );
  });
  await flush();
  return container;
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  ) as HTMLButtonElement | undefined;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StudioOutputCard", () => {
  it("reads the artifact and renders kind, title, status, version, digest and the review card", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(detailBody("draft")));
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/studio/outputs/output-1",
    );
    expect(container.textContent).toContain("Copy proposal");
    expect(container.textContent).toContain("Synthetic copy proposal");
    expect(container.textContent).toContain("Draft");
    expect(container.textContent).toContain("Current version 1");
    expect(container.textContent).toContain("aaaaaaaaaaaa…");
    expect(container.textContent).toContain("Synthetic proposed title");
    expect(container.textContent).toContain("Requires human review");
    expect(
      container.querySelector(
        'a[href="/listings/listing-1?studioOutput=output-1"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('a[href="/studio/t/thread-1"]'),
    ).not.toBeNull();
    // A draft has no export link yet; the controls say to save first.
    expect(container.textContent).toContain("Download JSON");
    expect(container.textContent).toContain("Save before exporting.");
    expect(container.querySelector('a[href*="/export?digest="]')).toBeNull();
  });

  it("enables JSON and PDF export links with the latest digest once saved", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(detailBody("saved")));
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    const digest = "a".repeat(64);
    const json = container.querySelector(
      `a[href="/api/studio/outputs/output-1/export?digest=${digest}&format=json"]`,
    );
    const pdf = container.querySelector(
      `a[href="/api/studio/outputs/output-1/export?digest=${digest}&format=pdf"]`,
    );
    expect(json?.textContent).toBe("Download JSON");
    expect(pdf?.textContent).toBe("Download PDF");
    expect(container.textContent).toContain(
      "Only a saved or signed-off artifact can be exported.",
    );
  });

  it("saves through the action endpoint and trusts only the server readback", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "/api/studio/outputs/output-1" && init?.method === "POST") {
          return Response.json({
            outputId: "output-1",
            status: "saved",
            version: 2,
          });
        }
        return Response.json(detailBody("draft"));
      });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    expect(container.textContent).toContain("Draft");

    const save = buttonByText(container, "Save artifact");
    expect(save).not.toBeUndefined();
    expect(save?.disabled).toBe(false);

    await act(async () => {
      save?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const postCall = fetcher.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ action: "save" });
    // The server response is the readback; the card repeats it.
    expect(container.textContent).toContain("Saved");
    expect(container.textContent).toContain("Current version 2");
    expect(container.textContent).toContain(
      "Saved; confirmed by the server readback.",
    );
    expect(buttonByText(container, "Save artifact")?.disabled).toBe(true);
  });

  it("shows an honest load failure with a retry and no invented content", async () => {
    let attempt = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      attempt += 1;
      return attempt === 1
        ? Response.json({ code: "internal_error" }, { status: 500 })
        : Response.json(detailBody("draft"));
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "The artifact could not be loaded; nothing is estimated.",
    );
    expect(container.textContent).not.toContain("Synthetic proposed title");

    const retry = alert?.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(attempt).toBe(2);
    expect(container.textContent).toContain("Synthetic proposed title");
  });

  it("renders an honest unavailable state for an invalid proposal payload", async () => {
    const body = detailBody("draft");
    const invalid = {
      ...body,
      versions: [{ ...body.versions[0], payload: {} }],
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json(invalid)),
    );

    const container = await mount();
    expect(container.textContent).toContain(
      "This proposal could not be displayed; nothing is invented.",
    );
    expect(container.querySelector("table")).toBeNull();
  });

  it("does not fetch an expandable row until it is opened", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(detailBody("draft")));
    vi.stubGlobal("fetch", fetcher);

    const container = await mount({
      expandable: true,
      initialSummary: {
        title: "Synthetic listed proposal",
        kind: "copy_proposal",
        status: "draft",
      },
      canSignOff: false,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Synthetic listed proposal");
    expect(container.textContent).toContain("View artifact");

    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Synthetic proposed title");
  });

  it("disables sign-off for a non-reviewer and states the required role", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json(detailBody("saved"))),
    );

    const container = await mount({ canSignOff: false });

    const signOff = buttonByText(container, "Sign off");
    expect(signOff?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "A reviewer or higher role is required to sign off.",
    );
  });

  it("requires a saved artifact before sign-off", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json(detailBody("draft"))),
    );

    const container = await mount({ canSignOff: true });
    const signOff = buttonByText(container, "Sign off");
    expect(signOff?.disabled).toBe(true);
    expect(signOff?.title).toContain("Save the artifact before signing off.");
  });

  it("signs off a saved artifact and shows the readback state", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
          return Response.json({
            outputId: "output-1",
            status: "signed_off",
            version: 2,
          });
        }
        return Response.json(detailBody("saved"));
      });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount({ canSignOff: true });
    const signOff = buttonByText(container, "Sign off");
    expect(signOff?.disabled).toBe(false);

    await act(async () => {
      signOff?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const postCall = fetcher.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      action: "sign_off",
    });
    expect(container.textContent).toContain("Signed off");
    expect(container.textContent).toContain(
      "Signed off; confirmed by the server readback.",
    );
    expect(container.textContent).toContain("Current version 2");
  });

  it("reports a 403 sign-off honestly with the required role copy", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        if (init?.method === "POST") {
          return Response.json({ code: "insufficient_role" }, { status: 403 });
        }
        void input;
        return Response.json(detailBody("saved"));
      });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount({ canSignOff: true });
    await act(async () => {
      buttonByText(container, "Sign off")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "A reviewer or higher role is required to sign off.",
    );
    // No success is claimed when the server refused.
    expect(container.textContent).not.toContain(
      "Signed off; confirmed by the server readback.",
    );
    expect(container.textContent).toContain("Saved");
  });

  it("renders a finding artifact with the read-only category card", async () => {
    const findingPayload = {
      schemaVersion: "wukong-category-map/v1",
      listingId: "11111111-1111-4111-8111-111111111111",
      listingTitle: "Synthetic wine",
      currentCategory: null,
      suggestions: [
        {
          path: "Beverages > Wine > Red",
          confidence: 0.8,
          rationale: null,
          evidenceRefs: ["catalog:listing-1"],
        },
      ],
      limitations: [],
      asOf: "2026-11-08T00:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () =>
        Response.json({
          output: {
            outputId: "output-finding",
            kind: "finding",
            title: "Category map proposal",
            status: "draft",
            currentVersion: 1,
            threadId: null,
            createdAt: "2026-11-08T00:00:00.000Z",
            updatedAt: "2026-11-08T00:00:00.000Z",
          },
          versions: [
            {
              revision: 1,
              payload: findingPayload,
              contentDigest: "b".repeat(64),
              asOf: "2026-11-08T00:00:00.000Z",
              scope: { listingId: findingPayload.listingId },
              createdBy: "studio",
              createdAt: "2026-11-08T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    const container = await mount({ outputId: "output-finding" });
    expect(container.textContent).toContain("Category mapping proposal");
    expect(container.textContent).toContain("Beverages > Wine > Red");
    expect(container.textContent).toContain(
      "Not applied — a person can only change the category in the existing catalog flow.",
    );
    expect(
      container.querySelector(
        'a[href="/listings/11111111-1111-4111-8111-111111111111"]',
      ),
    ).not.toBeNull();
  });

  it("renders zh-Hant copy for the zh-Hant locale", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json(detailBody("draft"))),
    );

    const container = await mount({ locale: "zh-Hant" });
    expect(container.textContent).toContain("文案建議");
    expect(container.textContent).toContain("目前版本 1");
    expect(container.textContent).toContain("儲存成品");
    expect(container.textContent).toContain("簽核");
  });
});
