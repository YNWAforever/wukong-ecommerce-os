// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../lib/locale-context.js";
import type { Locale } from "../lib/locale.js";
import { sharedMessages } from "../lib/ui-copy.js";
import { CreateBatchForm, submitCreateBatch } from "./create-batch-form.js";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/batches",
  useSearchParams: () => new URLSearchParams(),
}));

const validInput = {
  label: "zh names",
  gap: "untranslatedName" as const,
  budgetUsd: 5,
  waveSize: 3,
};

describe("submitCreateBatch", () => {
  it("returns a network_error when the fetcher throws", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await submitCreateBatch(validInput, { fetcher });

    // The same copy every batch screen shows, so the four cannot drift.
    expect(result).toEqual({
      kind: "network_error",
      message: sharedMessages.unreachable,
    });
  });

  it("returns a success outcome with the real response fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { batchId: "batch_1", selected: 4, budgetUsd: 5, waveSize: 3 },
          { status: 201 },
        ),
      );

    const result = await submitCreateBatch(validInput, { fetcher });

    expect(result).toEqual({
      kind: "success",
      batchId: "batch_1",
      selected: 4,
      budgetUsd: 5,
      waveSize: 3,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    ["invalid_budget", "A batch needs a budget greater than zero."],
    ["invalid_wave_size", "Wave size must be a whole number from 1 to 5."],
    [
      "empty_cohort",
      "No products match that gap, so there is nothing to enrich.",
    ],
    ["insufficient_role", "Operator access is required."],
  ])("maps API error code %s to its message", async (code, english) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code, message: "server detail" }, { status: 400 }),
      );

    const result = await submitCreateBatch(validInput, { fetcher });

    expect(result).toMatchObject({ kind: "api_error", code });
    if (result.kind === "success") throw new Error("expected a failure");
    // The English half is unchanged; the Chinese half must be a real
    // translation rather than the same sentence twice.
    expect(result.message[1]).toBe(english);
    expect(result.message[0]).not.toBe(english);
  });
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function nativeSet(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CreateBatchForm", () => {
  it("calls onCreated after a successful submit", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { batchId: "batch_1", selected: 4, budgetUsd: 5, waveSize: 3 },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const onCreated = vi.fn();

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(CreateBatchForm, { onCreated }));
    });

    const inputs = container.querySelectorAll<HTMLInputElement>("input");
    const labelInput = inputs[0]!;
    const budgetInput = inputs[1]!;
    const form = container.querySelector("form")!;

    await act(async () => {
      nativeSet(labelInput, "zh names");
      nativeSet(budgetInput, "5");
    });

    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string),
    ).toEqual({
      label: "zh names",
      gap: "untranslatedName",
      budgetUsd: 5,
      waveSize: 3,
    });

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders the error message via the intake-message paragraph after a failed submit", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "empty_cohort", message: "server detail" },
          { status: 422 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const onCreated = vi.fn();

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(CreateBatchForm, { onCreated }));
    });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const message = container.querySelector(".intake-message");
    // Chinese, because that is the default locale. This paragraph used to be
    // English whatever language the reader had chosen.
    expect(message?.textContent).toBe(
      "沒有商品符合該缺口，因此沒有可補充的內容。",
    );
    expect(onCreated).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});

// Chromium rejects a native fetch called with the dependency object as receiver.
it("calls browser fetch without a dependency-object receiver", async () => {
  const fetcher = async function (this: unknown) {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    return Response.json({
      batchId: "batch_1",
      selected: 2,
      budgetUsd: 1,
      waveSize: 2,
      status: "running",
      enqueued: 2,
      spentUsd: 0,
    });
  } as typeof fetch;
  expect((await submitCreateBatch(validInput, { fetcher })).kind).toBe(
    "success",
  );
});

/**
 * The form the pilot journey fills in, in the reader's language.
 *
 * Every label printed both languages at once, and the six gap descriptions
 * were Chinese only -- so an English reader chose which cohort to enrich from
 * a list they could not read. The English label text is load-bearing:
 * tests/e2e/bulk-update-pilot.spec.ts fills these by /Label/, /Budget/ and
 * /Wave size/ with the fixture pinned to locale=en.
 */
describe("CreateBatchForm localisation", () => {
  async function mountWithLocale(locale: Locale) {
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          locale,
          children: createElement(CreateBatchForm, {}),
        }),
      );
    });
    return { container, root };
  }

  async function unmountLocale(root: Root) {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  }

  it("keeps the English names the pilot journey selects by", async () => {
    const { container, root } = await mountWithLocale("en");
    try {
      const labels = Array.from(container.querySelectorAll("label")).map(
        (label) => label.textContent ?? "",
      );

      expect(labels.some((text) => /Label/.test(text))).toBe(true);
      expect(labels.some((text) => /Budget/.test(text))).toBe(true);
      expect(labels.some((text) => /Wave size/.test(text))).toBe(true);
      expect(container.querySelector("button")?.textContent).toBe(
        "Create batch",
      );
    } finally {
      await unmountLocale(root);
    }
  });

  it("describes every gap in the reader's language", async () => {
    // These were Chinese only, so an English reader could not tell the six
    // cohorts apart.
    const { container, root } = await mountWithLocale("en");
    try {
      const options = Array.from(container.querySelectorAll("option"));

      expect(options).toHaveLength(6);
      for (const option of options) {
        expect(option.textContent).toMatch(/[A-Za-z]/);
        expect(option.textContent).not.toMatch(/[\u4e00-\u9fff]/);
      }
    } finally {
      await unmountLocale(root);
    }
  });

  it("shows one language at a time", async () => {
    const { container, root } = await mountWithLocale("zh-Hant");
    try {
      expect(container.textContent).not.toContain("Create batch");
      expect(container.querySelector("button")?.textContent).toBe("建立批次");
    } finally {
      await unmountLocale(root);
    }
  });
});
