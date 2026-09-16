// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, vi } from "vitest";
import { emptyWorkingListing } from "@wukong/core";
import { ListingWorkingCopy } from "./listing-working-copy";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});
const input = {
  revision: 1,
  baseVersionId: null,
  note: null,
  workingContent: emptyWorkingListing(),
  fieldStates: {},
  sources: [],
};
async function render(overrides: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ListingWorkingCopy, {
        listingId: "00000000-0000-4000-8000-000000000101",
        input,
        sources: [],
        canEdit: true,
        onSaved: async () => {},
        ...overrides,
      } as any),
    ),
  );
}
describe("working-copy recovery", () => {
  it("saves empty partial content without creating a model run", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ inputRevision: 2, processing: null }));
    vi.stubGlobal("fetch", fetcher);
    await render();
    const button = container.querySelector(
      '[data-action="save"]',
    ) as HTMLButtonElement;
    await act(async () => button.click());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({
      expectedInputRevision: 1,
      baseVersionId: null,
      action: "save",
    });
    expect(
      (container.querySelector('[data-action="promote"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("omits persisted source digests from the strict save contract", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ inputRevision: 2, processing: null }));
    vi.stubGlobal("fetch", fetcher);
    await render({
      input: {
        ...input,
        sources: [
          {
            assetId: "00000000-0000-4000-8000-000000000301",
            role: "front_label",
            use: "analyse",
            hero: true,
            digest: "a".repeat(64),
          },
        ],
      },
    });
    await act(async () => {
      (
        container.querySelector('[data-action="save"]') as HTMLButtonElement
      ).click();
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).sources).toEqual([
      {
        assetId: "00000000-0000-4000-8000-000000000301",
        role: "front_label",
        use: "analyse",
        hero: true,
      },
    ]);
  });
  it("keeps the operation key when a save response is lost", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(Response.json({ inputRevision: 2 }));
    vi.stubGlobal("fetch", fetcher);
    await render();
    await act(async () => {
      (
        container.querySelector('[data-action="save"]') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (
        container.querySelector('[data-action="save"]') as HTMLButtonElement
      ).click();
    });
    expect(fetcher.mock.calls[0]![1].headers["Idempotency-Key"]).toBe(
      fetcher.mock.calls[1]![1].headers["Idempotency-Key"],
    );
  });
  it("keeps editing unavailable to viewers", async () => {
    await render({ canEdit: false });
    expect(
      (container.querySelector('[data-action="save"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

it("preserves unsaved note when polling supplies a newer input revision", async () => {
  await render();
  const note = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(note, "Unsaved operator note");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(note.value).toBe("Unsaved operator note");
  await act(async () =>
    root.render(
      createElement(ListingWorkingCopy, {
        listingId: "00000000-0000-4000-8000-000000000101",
        input: { ...input, revision: 2, note: "New server note" },
        sources: [],
        canEdit: true,
        onSaved: async () => {},
      }),
    ),
  );
  expect(
    (container.querySelector("textarea") as HTMLTextAreaElement).value,
  ).toBe("Unsaved operator note");
});

it.each(["title.en", "producer"])(
  "adopts only selected stored %s through the displayed run",
  async (selectedField) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          candidate: {
            inputRevision: 1,
            baseVersionId: null,
            fields: [
              {
                field: selectedField,
                value: "AI candidate",
                currentValue: "",
                eligible: true,
                reason: null,
                evidence: [],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ inputRevision: 2 }));
    vi.stubGlobal("fetch", fetcher);
    await render({ currentRunId: "00000000-0000-4000-8000-000000000201" });
    await act(async () => {
      (
        container.querySelector(
          '[data-action="load-candidate"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (
        container.querySelector(
          `[data-candidate-field="${selectedField}"]`,
        ) as HTMLInputElement
      ).click();
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-action="adopt-candidate"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(fetcher.mock.calls[1]![0]).toContain(
      "/runs/00000000-0000-4000-8000-000000000201/adopt",
    );
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      expectedInputRevision: 1,
      baseVersionId: null,
      selectedFieldPaths: [selectedField],
    });
  },
);
