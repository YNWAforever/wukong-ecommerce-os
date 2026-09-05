import { describe, expect, it } from "vitest";
import {
  websiteProductSchema,
  websiteScanEnvelopeSchema,
  websiteScanStateSchema,
} from "./website-catalog.js";
const product = {
  key: "https://store.example/products/a",
  sourceUrl: "https://store.example/products/a",
  capturedAt: "2026-09-06T00:00:00Z",
  title: "茶",
  description: null,
  imageUrls: [],
  price: null,
  availability: "unknown",
  attributes: {},
  fieldSources: {},
  warnings: [],
};
describe("website observations", () => {
  it("accepts explicit unknowns without platform identity", () => {
    expect(websiteProductSchema.parse(product)).toEqual(product);
    expect(websiteScanStateSchema.parse("partial")).toBe("partial");
  });
  it("rejects extra platform fields and mismatched identity", () => {
    expect(
      websiteProductSchema.safeParse({ ...product, remoteProductId: "1" })
        .success,
    ).toBe(false);
    expect(
      websiteProductSchema.safeParse({ ...product, key: "other" }).success,
    ).toBe(false);
  });
  it.each([
    "http://store.example/a",
    "https://127.0.0.1/a",
    "https://10.0.0.1/a",
    "https://[::1]/a",
    "https://store.local/a",
    "https://user@store.example/a",
    "https://store.example:8443/a",
  ])("rejects unsafe references %s", (url) => {
    expect(
      websiteProductSchema.safeParse({ ...product, imageUrls: [url] }).success,
    ).toBe(false);
  });
  it("validates money as decimal strings and strict nested objects", () => {
    for (const amount of [1, "-1", "1e3", "NaN", "1,000", "01.2"])
      expect(
        websiteProductSchema.safeParse({
          ...product,
          price: { amount, currency: "HKD" },
        }).success,
      ).toBe(false);
    expect(
      websiteProductSchema.parse({
        ...product,
        price: { amount: "123.50", currency: "HKD" },
      }).price?.amount,
    ).toBe("123.50");
  });
  it("bounds fields, records and unique products", () => {
    for (const patch of [
      { title: "x".repeat(501) },
      { description: "x".repeat(20001) },
      { imageUrls: Array(11).fill(product.sourceUrl) },
      {
        attributes: Object.fromEntries(
          Array.from({ length: 31 }, (_, i) => [String(i), "x"]),
        ),
      },
      { warnings: Array(31).fill("x") },
    ])
      expect(
        websiteProductSchema.safeParse({ ...product, ...patch }).success,
      ).toBe(false);
    expect(
      websiteScanEnvelopeSchema.safeParse({
        products: [product, product],
        warnings: [],
      }).success,
    ).toBe(false);
  });
  it("rejects an oversized normalized UTF8 envelope", () => {
    const products = Array.from({ length: 20 }, (_, i) => ({
      ...product,
      key: product.key + i,
      sourceUrl: product.sourceUrl + i,
      description: "茶".repeat(20000),
    }));
    expect(
      websiteScanEnvelopeSchema.safeParse({ products, warnings: [] }).success,
    ).toBe(false);
  });
});
