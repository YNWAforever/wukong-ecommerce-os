// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WineContentReview } from "./wine-content-review";
import { sections } from "./wine-ui-test-fixtures";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("edits a bilingual paragraph, saves only its text and keeps the other paragraph untouched", async () => {
  const el = document.createElement("div"),
    root = createRoot(el),
    save = vi.fn().mockResolvedValue(undefined),
    regenerate = vi.fn();
  await act(async () =>
    root.render(
      <WineContentReview
        sections={sections}
        revision={2}
        baseVersionId="base"
        onSave={save}
        onRegenerate={regenerate}
        canEdit
        busy={false}
      />,
    ),
  );
  const textarea = el.querySelector(
    'textarea[lang="en"]',
  ) as HTMLTextAreaElement;
  expect(textarea).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "My edit");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(
    (el.querySelector('[data-regenerate="pairing"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () =>
    (
      el.querySelector('[data-action="save-sections"]') as HTMLButtonElement
    ).click(),
  );
  expect(save).toHaveBeenCalledWith({
    expectedInputRevision: 2,
    baseVersionId: "base",
    sectionChanges: [
      {
        key: "introduction",
        en: "My edit",
        "zh-Hant": "原有介紹",
        locked: false,
      },
    ],
  });
  expect(
    (el.querySelectorAll('textarea[lang="en"]')[1] as HTMLTextAreaElement)
      .value,
  ).toBe("Original pairing");
  await act(async () => root.unmount());
});

const preference = vi.hoisted(() => ({ locale: "en" }));
vi.mock("../lib/locale-context", () => ({
  useLocale: () => preference.locale,
}));

it("retains unsaved paragraph and original revision across locale changes and server refresh", async () => {
  preference.locale = "en";
  const el = document.createElement("div"),
    root = createRoot(el),
    save = vi.fn().mockRejectedValue(Error("stale"));
  const props = {
    sections,
    revision: 2,
    baseVersionId: "base",
    onSave: save,
    onRegenerate: vi.fn(),
    canEdit: true,
    busy: false,
  };
  await act(async () => root.render(<WineContentReview {...props} />));
  const textarea = el.querySelector(
    'textarea[lang="en"]',
  ) as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "Keep my draft");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  preference.locale = "zh-Hant";
  await act(async () =>
    root.render(
      <WineContentReview
        {...props}
        revision={3}
        sections={sections.map((s) => ({ ...s, en: "Server changed" }))}
      />,
    ),
  );
  expect(
    (el.querySelector('textarea[lang="en"]') as HTMLTextAreaElement).value,
  ).toBe("Keep my draft");
  expect(el.textContent).toContain("有未儲存修改");
  await act(async () =>
    (
      el.querySelector('[data-action="save-sections"]') as HTMLButtonElement
    ).click(),
  );
  expect(save.mock.calls[0]![0].expectedInputRevision).toBe(2);
  expect(
    (el.querySelector('textarea[lang="en"]') as HTMLTextAreaElement).value,
  ).toBe("Keep my draft");
  expect(el.querySelector('[role="alert"]')).not.toBeNull();
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal("confirm", confirm);
  await act(async () => {
    const button = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("放棄修改"),
    )!;
    button.click();
  });
  expect(confirm).toHaveBeenCalled();
  expect(
    (el.querySelector('textarea[lang="en"]') as HTMLTextAreaElement).value,
  ).toBe("Keep my draft");
  vi.unstubAllGlobals();
  await act(async () => root.unmount());
  preference.locale = "en";
});
