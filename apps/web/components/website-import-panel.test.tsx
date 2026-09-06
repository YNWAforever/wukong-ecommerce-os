// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WebsiteImportPanel } from "./website-import-panel";
const language = vi.hoisted(() => ({ value: "en" }));
vi.mock("../lib/locale-context", () => ({ useLocale: () => language.value }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const product = {
  key: "https://store.example/p",
  sourceUrl: "https://store.example/p",
  title: "Sample bottle",
  capturedAt: "2026-09-06T00:00:00Z",
  description: "<script>bad()</script>",
  availability: "unknown",
  imageUrls: [],
  attributes: {},
  fieldSources: { title: "json_ld" },
  warnings: [],
};
const scan = (state = "ready", id = "one") => ({
  id,
  state,
  sourceUrl: "https://store.example/",
  capturedAt: product.capturedAt,
  products: state === "queued" ? [] : [product],
  warnings: state === "partial" ? ["product_limit"] : [],
  progress: { scanned: 1, selectedCandidates: 1 },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
async function mount(fetcher: ReturnType<typeof vi.fn>, canScan = true) {
  window.history.replaceState(null, "", "/listings/import");
  vi.stubGlobal("fetch", fetcher);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(createElement(WebsiteImportPanel, { canScan })),
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function input(value: string) {
  await act(async () => {
    const el = container.querySelector<HTMLInputElement>("input[type=url]")!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
  language.value = "en";
});
it("previews and saves without connection or credentials, escaping descriptions", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(scan()))
    .mockResolvedValueOnce(json({ savedIds: ["p"], alreadySavedIds: [] }));
  await mount(fetcher);
  await input("https://store.example/");
  await click("Preview products");
  expect(container.textContent).toContain("Sample bottle");
  expect(container.textContent).toContain("20 products");
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("<script>bad()</script>");
  expect(window.location.search).toContain("scan=one");
  expect(container.querySelector("input[type=password]")).toBeNull();
  await act(async () =>
    container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(),
  );
  await click("Save selected products");
  expect(container.textContent).toContain("1 product saved");
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    keys: [product.key],
  });
});
it("gives viewers guidance and permits reviewer-equivalent capability", async () => {
  await mount(vi.fn(), false);
  expect(container.textContent).toContain("Operator access or higher");
  expect(
    container.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled,
  ).toBe(true);
});
it("rejects unsafe URLs before requests and handles expired sessions", async () => {
  const fetcher = vi.fn().mockResolvedValue(json({}, 401));
  await mount(fetcher);
  await input("https://127.0.0.1/");
  await click("Preview products");
  expect(fetcher).not.toHaveBeenCalled();
  expect(container.textContent).toContain("public HTTPS");
  await input("https://store.example/");
  await click("Preview products");
  expect(container.textContent).toContain("Sign in again");
});
it("polls queued/running state and stops on a partial preview", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(scan("queued")))
    .mockResolvedValueOnce(json(scan("running")))
    .mockResolvedValueOnce(json(scan("partial")));
  await mount(fetcher);
  await input("https://store.example/");
  await click("Preview products");
  expect(container.textContent).toContain("Queued");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(container.textContent).toContain("Scanning");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(container.textContent).toContain("Partial preview");
  expect(container.textContent).toContain("20-product preview limit");
});
it("keeps the previous preview visible during retry and invalidates selection", async () => {
  let resolve!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(scan("partial")))
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  await mount(fetcher);
  await input("https://store.example/");
  await click("Preview products");
  await act(async () =>
    container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(),
  );
  await click("Retry scan");
  expect(container.textContent).toContain("Sample bottle");
  expect(container.textContent).toContain("Previous preview");
  expect(
    container.querySelector<HTMLInputElement>("input[type=checkbox]")!.disabled,
  ).toBe(true);
  await act(async () => resolve(json(scan("failed", "two"))));
  expect(container.textContent).toContain("Scan failed");
});
it("ignores a late creation response after storefront changes and aborts on unmount", async () => {
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await mount(fetcher);
  await input("https://store.example/");
  await click("Preview products");
  const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
  await input("https://other.example/");
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(json(scan())));
  expect(container.textContent).not.toContain("Sample bottle");
  expect(window.location.search).not.toContain("scan=");
});

it("reuses the creation idempotency key after a lost response", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce(json(scan()));
  await mount(fetcher);
  await input("https://store.example/");
  await click("Preview products");
  await click("Retry scan");
  const bodies = fetcher.mock.calls.map((call) => JSON.parse(call[1].body));
  expect(bodies[0].requestKey).toBe(bodies[1].requestKey);
  expect(container.textContent).toContain("Sample bottle");
});
it("ignores a stale poll after the storefront changes", async () => {
  vi.useFakeTimers();
  let resolve!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(scan("queued")))
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  await mount(fetcher);
  await input("https://store.example/");
  await click("Preview products");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  await input("https://other.example/");
  await act(async () => resolve(json(scan())));
  expect(container.textContent).not.toContain("Sample bottle");
  expect(
    container.querySelector<HTMLInputElement>("input[type=url]")!.value,
  ).toBe("https://other.example/");
});
it("disables duplicate save requests until the first completes", async () => {
  let resolve!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(scan()))
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  await mount(fetcher);
  await input("https://store.example/");
  await click("Preview products");
  await act(async () =>
    container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(),
  );
  await click("Save selected products");
  await click("Save selected products");
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () =>
    resolve(json({ savedIds: [], alreadySavedIds: ["p"] })),
  );
  expect(container.textContent).toContain("1 product saved");
});

it.each([
  ["en", "Preview products", "Some pages could not be read"],
  ["zh-Hant", "預覽商品", "部分頁面無法讀取"],
])("localizes partial scan warnings in %s", async (locale, button, message) => {
  language.value = locale!;
  await mount(
    vi.fn().mockResolvedValue(
      json({
        ...scan("partial"),
        warnings: ["document_unavailable", "unknown_diagnostic"],
      }),
    ),
  );
  await input("https://store.example/");
  await click(button!);
  expect(container.textContent).toContain(message);
  expect(container.textContent).not.toContain("document_unavailable");
  expect(container.textContent).not.toContain("unknown_diagnostic");
});
