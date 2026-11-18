import { describe, expect, it } from "vitest";
import { productTitle } from "./product-title";

describe("productTitle", () => {
  it.each(["en", "zh-Hant"] as const)(
    "prefers %s, then the alternate language, then the legacy title",
    (locale) => {
      const alternate = locale === "en" ? "zh-Hant" : "en";
      const item = {
        title: "Legacy wine",
        titles: { [locale]: "Preferred wine", [alternate]: "Alternate wine" },
      };
      expect(productTitle(item, locale)).toBe("Preferred wine");
      item.titles[locale] = " \t\n";
      expect(productTitle(item, locale)).toBe("Alternate wine");
      item.titles[alternate] = "";
      expect(productTitle(item, locale)).toBe("Legacy wine");
    },
  );

  it.each([undefined, null, {}])(
    "keeps legacy responses usable with titles=%j",
    (titles) => {
      expect(productTitle({ title: "import.xlsx", titles }, "en")).toBe(
        "import.xlsx",
      );
    },
  );

  it.each([null, "", " \t\n"])(
    "returns null when no usable name remains (legacy=%j)",
    (title) => {
      expect(
        productTitle({ title, titles: { en: " ", "zh-Hant": null } }, "en"),
      ).toBeNull();
    },
  );

  it.each([{ value: 42 }, { value: false }, { value: {} }, { value: [] }])(
    "skips malformed translations from JSON ($value)",
    ({ value }) => {
      // API JSON is cast to the response contract at the dashboard boundary.
      const malformed = value as unknown as string;
      expect(
        productTitle(
          {
            title: "Legacy wine",
            titles: { en: malformed, "zh-Hant": "中文酒款" },
          },
          "en",
        ),
      ).toBe("中文酒款");
      expect(
        productTitle(
          { title: "Legacy wine", titles: { en: " ", "zh-Hant": malformed } },
          "en",
        ),
      ).toBe("Legacy wine");
    },
  );

  it("preserves nonblank names verbatim and never changes either language", () => {
    const item = Object.freeze({
      title: "Legacy wine",
      titles: Object.freeze({ en: "  English wine  ", "zh-Hant": "中文酒款" }),
    });
    expect(productTitle(item, "en")).toBe("  English wine  ");
    expect(productTitle(item, "zh-Hant")).toBe("中文酒款");
    expect(productTitle(item, "en")).toBe("  English wine  ");
  });
});
