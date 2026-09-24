import { expect, test } from "@playwright/test";
import { localBrowserUrl } from "./catalog-usability-checks.js";

test("locale checks use Playwright's resolved local base URL", ({
  baseURL,
}) => {
  expect(localBrowserUrl(baseURL)).toBe(baseURL);
});

test("locale checks retain the loopback-only browser boundary", () => {
  for (const url of [
    "http://127.0.0.1:49217",
    "http://localhost:49245",
    "http://[::1]:49217",
  ]) {
    expect(localBrowserUrl(url)).toBe(url);
  }
  for (const url of [
    undefined,
    "https://merchant.example",
    "file://localhost/workbook",
    "http://localhost.merchant.example",
  ]) {
    expect(() => localBrowserUrl(url)).toThrow("Loopback browser URL required");
  }
});
