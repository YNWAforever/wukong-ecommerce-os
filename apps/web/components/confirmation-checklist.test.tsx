// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allConfirmed,
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
  ConfirmationChecklist,
} from "./confirmation-checklist";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const emptyFieldConfirmations: Record<string, boolean> = {};
const emptyNegativeConfirmations: Record<string, boolean> = {};

const fullFieldConfirmations: Record<string, boolean> = Object.fromEntries(
  CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
);
const fullNegativeConfirmations: Record<string, boolean> = Object.fromEntries(
  CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
);

describe("CONFIRMATION_FIELD_KEYS / CONFIRMATION_NEGATIVE_KEYS", () => {
  it("cover the 8 AI-writable fields and 7 negative conditions", () => {
    expect(CONFIRMATION_FIELD_KEYS).toEqual([
      "nameZh",
      "summaryEn",
      "summaryZh",
      "seoTitleEn",
      "seoTitleZh",
      "seoDescriptionEn",
      "seoDescriptionZh",
      "seoKeywords",
    ]);
    expect(CONFIRMATION_NEGATIVE_KEYS).toEqual([
      "priceUnchanged",
      "membershipUnchanged",
      "categoryUnchanged",
      "statusUnchanged",
      "supplierUnchanged",
      "quantityDeltaNeutral",
      "noImageChange",
    ]);
  });
});

describe("allConfirmed", () => {
  it("is false when any of the 15 items is missing or false", () => {
    expect(
      allConfirmed(emptyFieldConfirmations, emptyNegativeConfirmations),
    ).toBe(false);
    expect(
      allConfirmed(fullFieldConfirmations, emptyNegativeConfirmations),
    ).toBe(false);
    expect(
      allConfirmed(
        { ...fullFieldConfirmations, seoKeywords: false },
        fullNegativeConfirmations,
      ),
    ).toBe(false);
  });

  it("is true only when all 8 field and 7 negative keys are true", () => {
    expect(
      allConfirmed(fullFieldConfirmations, fullNegativeConfirmations),
    ).toBe(true);
  });
});

describe("ConfirmationChecklist rendering", () => {
  it("renders all 15 items as checkboxes with their zh/en labels", () => {
    const markup = renderToStaticMarkup(
      createElement(ConfirmationChecklist, {
        fieldConfirmations: emptyFieldConfirmations,
        negativeConfirmations: emptyNegativeConfirmations,
        canConfirm: true,
      }),
    );

    // Field labels (zh / en)
    expect(markup).toContain("商品名稱（繁中）");
    expect(markup).toContain("Name (zh)");
    expect(markup).toContain("摘要（英文）");
    expect(markup).toContain("Summary (en)");
    expect(markup).toContain("摘要（繁中）");
    expect(markup).toContain("Summary (zh)");
    expect(markup).toContain("SEO 標題（英文）");
    expect(markup).toContain("SEO title (en)");
    expect(markup).toContain("SEO 標題（繁中）");
    expect(markup).toContain("SEO title (zh)");
    expect(markup).toContain("SEO 描述（英文）");
    expect(markup).toContain("SEO description (en)");
    expect(markup).toContain("SEO 描述（繁中）");
    expect(markup).toContain("SEO description (zh)");
    expect(markup).toContain("SEO 關鍵字");
    expect(markup).toContain("SEO keywords");

    // Negative condition labels (zh / en)
    expect(markup).toContain("售價未變動");
    expect(markup).toContain("Price unchanged");
    expect(markup).toContain("會員權益未變動");
    expect(markup).toContain("Membership unchanged");
    expect(markup).toContain("分類未變動");
    expect(markup).toContain("Category unchanged");
    expect(markup).toContain("上下架狀態未變動");
    expect(markup).toContain("Status unchanged");
    expect(markup).toContain("供應商未變動");
    expect(markup).toContain("Supplier unchanged");
    expect(markup).toContain("數量差額為中性");
    expect(markup).toContain("Quantity delta neutral");
    expect(markup).toContain("圖片無變動");
    expect(markup).toContain("No image change");

    const checkboxCount = (markup.match(/type="checkbox"/g) ?? []).length;
    expect(checkboxCount).toBe(15);
  });

  it("exposes an all-confirmed summary via a data attribute and a rendered count", () => {
    const incompleteMarkup = renderToStaticMarkup(
      createElement(ConfirmationChecklist, {
        fieldConfirmations: emptyFieldConfirmations,
        negativeConfirmations: emptyNegativeConfirmations,
        canConfirm: true,
      }),
    );
    expect(incompleteMarkup).toContain('data-all-confirmed="false"');
    expect(incompleteMarkup).toContain("0 / 15");

    const completeMarkup = renderToStaticMarkup(
      createElement(ConfirmationChecklist, {
        fieldConfirmations: fullFieldConfirmations,
        negativeConfirmations: fullNegativeConfirmations,
        canConfirm: true,
      }),
    );
    expect(completeMarkup).toContain('data-all-confirmed="true"');
    expect(completeMarkup).toContain("15 / 15");
  });

  it("disables every checkbox when canConfirm is false", () => {
    const markup = renderToStaticMarkup(
      createElement(ConfirmationChecklist, {
        fieldConfirmations: emptyFieldConfirmations,
        negativeConfirmations: emptyNegativeConfirmations,
        canConfirm: false,
      }),
    );
    const disabledCount = (markup.match(/disabled=""/g) ?? []).length;
    expect(disabledCount).toBe(15);
  });
});

const mountedRoots: Root[] = [];

async function mount(props: {
  fieldConfirmations: Record<string, boolean>;
  negativeConfirmations: Record<string, boolean>;
  canConfirm?: boolean;
  onChange?: (
    nextFieldConfirmations: Record<string, boolean>,
    nextNegativeConfirmations: Record<string, boolean>,
  ) => void;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(createElement(ConfirmationChecklist, props));
  });
  return { container, root };
}

describe("ConfirmationChecklist interaction", () => {
  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("calls onChange with the updated field-confirmation map when a field checkbox is toggled", async () => {
    const onChange = vi.fn();
    const { container } = await mount({
      fieldConfirmations: emptyFieldConfirmations,
      negativeConfirmations: emptyNegativeConfirmations,
      canConfirm: true,
      onChange,
    });

    const checkbox = container.querySelector(
      "#confirmation-field-nameZh",
    ) as HTMLInputElement;
    expect(checkbox).toBeTruthy();

    await act(async () => {
      checkbox.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      { nameZh: true },
      emptyNegativeConfirmations,
    );
  });

  it("calls onChange with the updated negative-confirmation map when a negative checkbox is toggled, leaving other keys untouched", async () => {
    const onChange = vi.fn();
    const { container } = await mount({
      fieldConfirmations: fullFieldConfirmations,
      negativeConfirmations: { priceUnchanged: true },
      canConfirm: true,
      onChange,
    });

    const checkbox = container.querySelector(
      "#confirmation-negative-categoryUnchanged",
    ) as HTMLInputElement;
    expect(checkbox).toBeTruthy();

    await act(async () => {
      checkbox.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(fullFieldConfirmations, {
      priceUnchanged: true,
      categoryUnchanged: true,
    });
  });

  it("unchecking a confirmed item calls onChange with that key set to false", async () => {
    const onChange = vi.fn();
    const { container } = await mount({
      fieldConfirmations: fullFieldConfirmations,
      negativeConfirmations: fullNegativeConfirmations,
      canConfirm: true,
      onChange,
    });

    const checkbox = container.querySelector(
      "#confirmation-field-seoKeywords",
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    await act(async () => {
      checkbox.click();
    });

    expect(onChange).toHaveBeenCalledWith(
      { ...fullFieldConfirmations, seoKeywords: false },
      fullNegativeConfirmations,
    );
  });
});
