// @vitest-environment happy-dom
/**
 * Approving with edits still in the box.
 *
 * `fields` is local state and approving sends only the loaded version id, so a
 * reviewer who corrected a title and pressed Approve without pressing Save
 * approved the version WITHOUT their correction -- while the screen showed the
 * corrected text the whole time, so there was nothing to notice.
 *
 * A separate file from `listing-fields-form.test.tsx` because that one renders
 * with `renderToStaticMarkup` and cannot type; the DOM environment is set
 * per-file by the pragma above.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "./confirmation-checklist";
import {
  ListingFieldsForm,
  type ListingReviewModel,
} from "./listing-fields-form";

vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));

const fieldConfirmations = Object.fromEntries(
  CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
);
const negativeConfirmations = Object.fromEntries(
  CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
);

/** Approvable: in review, every confirmation done, no open blocking flag. */
const model: ListingReviewModel = {
  id: "listing-1",
  versionId: "version-1",
  status: "in_review",
  fields: [
    {
      key: "producer",
      label: "生產者",
      englishLabel: "Producer",
      value: "Opak Cellar",
      confidence: 0.96,
      evidence: null,
    },
  ],
  blockingFlags: [],
};

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

async function mount(onApprove = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ListingFieldsForm
        model={model}
        fieldConfirmations={fieldConfirmations}
        negativeConfirmations={negativeConfirmations}
        onApprove={onApprove}
      />,
    );
  });
  const approve = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Approve listing"),
  ) as HTMLButtonElement;
  const producer = host.querySelector<HTMLInputElement>(
    "#listing-field-producer",
  )!;
  return { container: host, approve, producer, onApprove };
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("approving with unsaved edits", () => {
  it("allows approval while the form matches what was saved", async () => {
    const { approve } = await mount();

    expect(approve.disabled).toBe(false);
  });

  it("blocks approval as soon as a field is edited", async () => {
    const { approve, producer, onApprove } = await mount();

    await type(producer, "Opak Cellar Reserve");

    expect(approve.disabled).toBe(true);
    approve.click();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("says why, rather than just disabling the button", async () => {
    const { container, producer } = await mount();

    await type(producer, "Opak Cellar Reserve");

    expect(container.textContent).toContain("You have unsaved changes");
  });

  it("allows approval again once the edit is reverted", async () => {
    // Typing and undoing leaves the form matching the saved version, so there
    // is nothing unsaved and no reason to keep blocking.
    const { approve, producer } = await mount();

    await type(producer, "Opak Cellar Reserve");
    expect(approve.disabled).toBe(true);

    await type(producer, "Opak Cellar");

    expect(approve.disabled).toBe(false);
  });

  it("treats clearing a field as an edit", async () => {
    // Emptying a box writes null, which is a real change to the content and
    // must not be mistaken for leaving it alone.
    const { approve, producer } = await mount();

    await type(producer, "");

    expect(approve.disabled).toBe(true);
  });
});
