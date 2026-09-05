// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BulkImportPanel } from "./bulk-import-panel";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(BulkImportPanel)));
  return container;
}
async function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const summary = (overrides = {}) => ({
  connection: null,
  canManageConnection: true,
  canImport: true,
  credentialStorageConfigured: true,
  ...overrides,
});
it("keeps actual selected file and time through inline connect and imports original bytes without nested forms", async () => {
  let connected = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "/api/workspace/import-setup")
      return Response.json(
        summary({
          connection: connected
            ? { shopDomain: "synthetic.myshopline.com" }
            : null,
        }),
      );
    if (String(url) === "/api/workspace/connection") {
      if (init?.method === "POST") {
        connected = true;
        return Response.json({ shopDomain: "synthetic.myshopline.com" });
      }
      return Response.json({
        connection: connected
          ? {
              shopDomain: "synthetic.myshopline.com",
              connectedAt: "2026-01-01",
            }
          : null,
      });
    }
    return Response.json({
      parsedRows: 1,
      createdDrafts: 1,
      refreshedProducts: 0,
      issues: [],
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const container = await mount();
  const fileInput =
    container.querySelector<HTMLInputElement>("#bulk-import-file")!;
  const time = container.querySelector<HTMLInputElement>(
    "#merchant-attested-export-at",
  )!;
  const file = new File([new Uint8Array([80, 75, 3, 4, 5])], "synthetic.xlsx");
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  await act(async () =>
    fileInput.dispatchEvent(new Event("change", { bubbles: true })),
  );
  await enter(time, "2026-08-01T08:00");
  expect(
    container.querySelector<HTMLButtonElement>(
      ".intake-form button[type=submit]",
    )!.disabled,
  ).toBe(true);
  await click(container, "Set up store");
  expect(container.querySelector("form form")).toBeNull();
  await enter(
    container.querySelector<HTMLInputElement>(
      ".connection-form input[type=text]",
    )!,
    "synthetic.myshopline.com",
  );
  await enter(
    container.querySelector<HTMLInputElement>(
      ".connection-form input[type=password]",
    )!,
    "synthetic-token",
  );
  await act(async () =>
    container
      .querySelector(".connection-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(container.querySelector("#bulk-import-file")).toBe(fileInput);
  expect(fileInput.files?.[0]).toBe(file);
  expect(container.querySelector("#merchant-attested-export-at")).toBe(time);
  expect(time.value).toBe("2026-08-01T08:00");
  expect(
    container.querySelector<HTMLButtonElement>(
      ".intake-form button[type=submit]",
    )!.disabled,
  ).toBe(false);
  await act(async () =>
    container
      .querySelector(".intake-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const upload = fetcher.mock.calls.find(([url]) =>
    String(url).startsWith("/api/listings/import?"),
  )!;
  expect(upload[1]?.body).toBe(file);
  expect(await (upload[1]!.body as File).arrayBuffer()).toEqual(
    await file.arrayBuffer(),
  );
  expect(String(upload[0])).toContain(
    "merchantAttestedExportAt=2026-08-01T00%3A00%3A00.000Z",
  );
});
it.each([
  summary({ canManageConnection: false }),
  summary({ credentialStorageConfigured: false }),
])("gives guidance without requesting token entry", async (body) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body)),
  );
  const container = await mount();
  expect(container.querySelector("input[type=password]")).toBeNull();
  expect(container.textContent).toMatch(/administrator|credential storage/i);
  expect(
    [...container.querySelectorAll("button")].some((b) =>
      b.textContent?.includes("Set up store"),
    ),
  ).toBe(false);
});
it("fails closed and retries summary without uploading", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(
      Response.json(
        summary({
          connection: { shopDomain: "synthetic.myshopline.com" },
          credentialStorageConfigured: false,
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const container = await mount();
  expect(
    container.querySelector<HTMLButtonElement>(
      ".intake-form button[type=submit]",
    )!.disabled,
  ).toBe(true);
  await click(container, "Retry");
  expect(
    container.querySelector<HTMLButtonElement>(
      ".intake-form button[type=submit]",
    )!.disabled,
  ).toBe(false);
  expect(
    fetcher.mock.calls.every(([url]) => url === "/api/workspace/import-setup"),
  ).toBe(true);
});

it.each([401, 403])(
  "handles summary authorization failure %s without token entry or upload",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: "unauthorized" }, { status })),
    );
    const container = await mount();
    expect(container.textContent).toContain(
      "Sign in to an authorized workspace",
    );
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        ".intake-form button[type=submit]",
      )!.disabled,
    ).toBe(true);
  },
);
it("blocks connected viewers and keeps the import guard effective on synthetic submit", async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      summary({
        connection: { shopDomain: "synthetic.myshopline.com" },
        canManageConnection: false,
        canImport: false,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const container = await mount();
  expect(container.textContent).toContain("Operator access or higher");
  await act(async () =>
    container
      .querySelector(".intake-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("ignores late summary completion after unmount", async () => {
  let resolve!: (value: Response) => void;
  let signal!: AbortSignal;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    }),
  );
  await mount();
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(Response.json(summary())));
});
it("closes inline setup without replacing import inputs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      Response.json(
        String(url).includes("import-setup") ? summary() : { connection: null },
      ),
    ),
  );
  const container = await mount();
  const input = container.querySelector("#bulk-import-file");
  await click(container, "Set up store");
  expect(container.querySelector(".connection-form")).not.toBeNull();
  await click(container, "Close setup");
  expect(container.querySelector(".connection-form")).toBeNull();
  expect(container.querySelector("#bulk-import-file")).toBe(input);
});
