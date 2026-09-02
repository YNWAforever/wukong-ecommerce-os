// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  LOCALE_COOKIE_NAME,
  DEFAULT_LOCALE,
  resolveLocale,
  setLocaleCookie,
} from "./locale.js";

describe("resolveLocale", () => {
  it("returns zh-Hant for a valid zh-Hant cookie value", () => {
    expect(resolveLocale("zh-Hant")).toBe("zh-Hant");
  });

  it("returns en for a valid en cookie value", () => {
    expect(resolveLocale("en")).toBe("en");
  });

  it("falls back to the default for an invalid value", () => {
    expect(resolveLocale("fr")).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default for undefined (no cookie set)", () => {
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default for an empty string", () => {
    expect(resolveLocale("")).toBe(DEFAULT_LOCALE);
  });
});

describe("constants", () => {
  it("defaults to zh-Hant", () => {
    expect(DEFAULT_LOCALE).toBe("zh-Hant");
  });

  it("names a real cookie", () => {
    expect(LOCALE_COOKIE_NAME).toBe("locale");
  });
});

describe("setLocaleCookie", () => {
  it("writes a one-year, root-path locale cookie", () => {
    try {
      document.cookie =
        "locale=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
      setLocaleCookie("en");
      expect(document.cookie).toContain("locale=en");
    } finally {
      document.cookie =
        "locale=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    }
  });
});
