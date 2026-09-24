// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  ImportResultForm,
  type ImportResultReceipt,
} from "./import-result-form";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("preserves the exact in-flight payload and key for an ambiguous retry across parent receipt updates", async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise<Response>((_, no) => {
    reject = no;
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(Response.json({ replayed: true }));
  let key = 0;
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("crypto", { randomUUID: () => "key-" + ++key });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (latestResult: ImportResultReceipt | null) => {
    await act(async () =>
      root.render(
        createElement(ImportResultForm, {
          listingId: "listing-a",
          mode: "export",
          versionId: "version-a",
          exportAttemptId: "attempt-a",
          latestResult,
        }),
      ),
    );
  };
  try {
    await render(null);
    const button = container.querySelector("button")!;
    await act(async () => button.click());
    await render({
      id: "receipt-new",
      revision: 1,
      outcome: "accepted",
      rejectReason: null,
      correctionReason: null,
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(container.querySelector("button")).toBe(button);
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("lost response")));
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![1]!.body).toBe(
      fetcher.mock.calls[0]![1]!.body,
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      mode: "export",
      outcome: "accepted",
      versionId: "version-a",
      exportAttemptId: "attempt-a",
      idempotencyKey: "key-1",
    });
    expect(
      container.querySelector('textarea[aria-label="Correction reason"]'),
    ).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("retries the observed correction predecessor after refresh failure, then adopts latest evidence for new input", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ replayed: true }));
  const onRecorded = vi
    .fn()
    .mockRejectedValueOnce(new Error("refresh failed"))
    .mockResolvedValue(undefined);
  let key = 0;
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("crypto", { randomUUID: () => "key-" + ++key });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (revision: number) => {
    await act(async () =>
      root.render(
        createElement(ImportResultForm, {
          listingId: "listing-a",
          mode: "export",
          versionId: "version-a",
          exportAttemptId: "attempt-a",
          latestResult: {
            id: "receipt-" + revision,
            revision,
            outcome: "rejected",
            rejectReason: "original rejection",
            correctionReason: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
          onRecorded,
        }),
      ),
    );
  };
  const edit = async (value: string) => {
    await act(async () => {
      const input = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  try {
    await render(1);
    await edit("Confirmed accepted");
    await act(async () => container.querySelector("button")!.click());
    await render(2);
    await act(async () => container.querySelector("button")!.click());
    expect(fetcher.mock.calls[1]![1]!.body).toBe(
      fetcher.mock.calls[0]![1]!.body,
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toMatchObject({
      supersedesResultId: "receipt-1",
      correctionReason: "Confirmed accepted",
      idempotencyKey: "key-1",
      exportAttemptId: "attempt-a",
      versionId: "version-a",
    });
    await edit("Confirmed again");
    await act(async () => container.querySelector("button")!.click());
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]!.body))).toMatchObject({
      supersedesResultId: "receipt-2",
      correctionReason: "Confirmed again",
      idempotencyKey: "key-2",
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
