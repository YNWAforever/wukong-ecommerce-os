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

it("recovers a paragraph after accepted navigation and history remount with original guards until explicit discard", async () => {
  preference.locale = "en";
  sessionStorage.clear();
  const el = document.createElement("div");
  document.body.append(el);
  let root = createRoot(el);
  const save = vi.fn().mockRejectedValue(Error("stale")),
    key = "wine-listing-history-test",
    originalBase = "00000000-0000-4000-8000-000000000111";
  const props = {
    sections,
    revision: 2,
    baseVersionId: originalBase,
    onSave: save,
    onRegenerate: vi.fn(),
    canEdit: true,
    busy: false,
    draftKey: key,
  };
  await act(async () => root.render(<WineContentReview {...props} />));
  await act(async () => {
    const textarea = el.querySelector('textarea[lang="en"]')!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "History-safe edit");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const link = document.createElement("a");
  link.href = "/dashboard";
  el.append(link);
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal("confirm", confirm);
  const cancelled = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  await act(async () => link.dispatchEvent(cancelled));
  expect(cancelled.defaultPrevented).toBe(true);
  confirm.mockReturnValue(true);
  const accepted = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => link.dispatchEvent(accepted));
  expect(accepted.defaultPrevented).toBe(false);
  await act(async () => root.unmount());
  root = createRoot(el);
  await act(async () =>
    root.render(
      <WineContentReview
        {...props}
        revision={3}
        baseVersionId="00000000-0000-4000-8000-000000000112"
        sections={sections.map((s) => ({ ...s, en: "New server content" }))}
      />,
    ),
  );
  expect(
    (el.querySelector('textarea[lang="en"]') as HTMLTextAreaElement).value,
  ).toBe("History-safe edit");
  expect(el.textContent).toContain("Recovered unsaved");
  await act(async () =>
    (
      el.querySelector('[data-action="save-sections"]') as HTMLButtonElement
    ).click(),
  );
  expect(save.mock.calls[0]![0]).toMatchObject({
    expectedInputRevision: 2,
    baseVersionId: originalBase,
  });
  const discard = () =>
    [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Discard edits"),
    )!;
  confirm.mockReturnValue(false);
  await act(async () => discard().click());
  expect(sessionStorage.length).toBe(1);
  confirm.mockReturnValue(true);
  await act(async () => discard().click());
  expect(sessionStorage.length).toBe(0);
  expect(
    (el.querySelector('textarea[lang="en"]') as HTMLTextAreaElement).value,
  ).toBe("New server content");
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
it("clears local recovery only after successful save and reports unavailable storage", async () => {
  sessionStorage.clear();
  const el = document.createElement("div"),
    root = createRoot(el);
  const save = vi.fn().mockResolvedValue(undefined),
    props = {
      sections,
      revision: 2,
      baseVersionId: null,
      onSave: save,
      onRegenerate: vi.fn(),
      canEdit: true,
      busy: false,
      draftKey: "wine-listing-save-test",
    };
  await act(async () => root.render(<WineContentReview {...props} />));
  async function edit() {
    await act(async () => {
      const textarea = el.querySelector('textarea[lang="en"]')!;
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, "Saved edit");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await edit();
  expect(sessionStorage.length).toBe(1);
  await act(async () =>
    (
      el.querySelector('[data-action="save-sections"]') as HTMLButtonElement
    ).click(),
  );
  expect(sessionStorage.length).toBe(0);
  await act(async () => root.unmount());
  const unavailableRoot = createRoot(el);
  vi.stubGlobal("sessionStorage", {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("blocked");
    },
    removeItem() {
      throw Error("blocked");
    },
  });
  await act(async () =>
    unavailableRoot.render(<WineContentReview {...props} />),
  );
  expect(el.textContent).toContain("Local draft recovery is unavailable");
  await act(async () => unavailableRoot.unmount());
  vi.unstubAllGlobals();
});
