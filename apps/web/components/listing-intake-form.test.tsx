// @vitest-environment happy-dom
/**
 * Choosing files more than once.
 *
 * A bottle shot and a back label are two trips to the file picker on most
 * phones. The second trip used to replace the whole selection, so the first
 * photo vanished with no warning and no way back to it except finding the file
 * again -- and nothing tested this component at all.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListingIntakeForm } from "./listing-intake-form.js";

function png(name: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function pdf(name: string): File {
  return new File([new Uint8Array(512)], name, { type: "application/pdf" });
}

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  if (root && host) {
    act(() => root!.unmount());
    host.remove();
  }
  root = undefined;
  host = undefined;
});

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ListingIntakeForm onCreate={vi.fn()} />);
  });
  const input = host.querySelector<HTMLInputElement>("#listing-files")!;
  return { container: host, input };
}

/** Drive the real change handler the way a picker would. */
async function choose(input: HTMLInputElement, files: File[]) {
  const list = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: files[Symbol.iterator].bind(files),
  } as unknown as FileList;
  files.forEach((file, index) => {
    (list as unknown as Record<number, File>)[index] = file;
  });
  Object.defineProperty(input, "files", { value: list, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function names(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".file-row strong")].map(
    (node) => node.textContent ?? "",
  );
}

describe("selecting files more than once", () => {
  it("keeps the first photo when a second is added", async () => {
    const { container, input } = await mount();

    await choose(input, [png("front.png")]);
    expect(names(container)).toEqual(["front.png"]);

    await choose(input, [png("back.png")]);

    expect(names(container)).toEqual(["front.png", "back.png"]);
  });

  it("does not add the same file twice", async () => {
    const { container, input } = await mount();
    const front = png("front.png");

    await choose(input, [front]);
    await choose(input, [front]);

    expect(names(container)).toEqual(["front.png"]);
  });

  it("applies the image cap across both selections, not each one", async () => {
    // Six then six is twelve. Validating only the new files would have let the
    // second batch through and sent eleven images to a server that takes ten.
    const { container, input } = await mount();

    await choose(
      input,
      Array.from({ length: 6 }, (_, i) => png(`a${i}.png`)),
    );
    await choose(
      input,
      Array.from({ length: 6 }, (_, i) => png(`b${i}.png`)),
    );

    expect(names(container)).toHaveLength(12);
    expect(container.querySelectorAll(".file-error")).toHaveLength(2);
  });

  it("caps PDFs across selections too", async () => {
    const { container, input } = await mount();

    await choose(input, [pdf("sheet.pdf")]);
    await choose(input, [pdf("other.pdf")]);

    expect(container.querySelectorAll(".file-error")).toHaveLength(1);
  });
});

describe("removing a chosen file", () => {
  it("drops just that file", async () => {
    const { container, input } = await mount();
    await choose(input, [png("front.png"), png("back.png")]);

    const remove =
      container.querySelectorAll<HTMLButtonElement>(".file-remove");
    await act(async () => remove[0]!.click());

    expect(names(container)).toEqual(["back.png"]);
  });

  it("re-admits a file that was over the cap", async () => {
    // Removing an image frees a slot, so the eleventh file is now usable.
    // Leaving it marked as an error would strand a photo the operator can use.
    const { container, input } = await mount();
    await choose(
      input,
      Array.from({ length: 11 }, (_, i) => png(`a${i}.png`)),
    );
    expect(container.querySelectorAll(".file-error")).toHaveLength(1);

    const remove =
      container.querySelectorAll<HTMLButtonElement>(".file-remove");
    await act(async () => remove[0]!.click());

    expect(container.querySelectorAll(".file-error")).toHaveLength(0);
    expect(names(container)).toHaveLength(10);
  });

  it("lets the same file be chosen again after removal", async () => {
    // The input's value is cleared after each change, so re-picking an
    // identical file still fires. Without that the picker looks broken.
    const { container, input } = await mount();
    await choose(input, [png("front.png")]);

    const remove =
      container.querySelectorAll<HTMLButtonElement>(".file-remove");
    await act(async () => remove[0]!.click());
    expect(names(container)).toEqual([]);

    await choose(input, [png("front.png")]);

    expect(names(container)).toEqual(["front.png"]);
  });
});
