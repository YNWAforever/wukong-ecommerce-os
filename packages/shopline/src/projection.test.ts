import { describe, expect, it } from "vitest";

import fixture from "../fixtures/shopline-create-product.json" with { type: "json" };

import {
  ShoplineValidationError,
  projectToShopline,
  validateShoplineProduct,
  validateShoplineProducts,
} from "./index.js";

const canonicalListing = fixture.canonicalListing;

describe("SHOPLINE projection", () => {
  it("maps bilingual content and exact stock visibility semantics", () => {
    const payload = projectToShopline(canonicalListing, fixture.imageUrls);

    expect(payload).toEqual(fixture.expectedPayload);
    expect(payload.product.title_translations).toEqual({
      en: "Demo Estate Riesling 2024",
      "zh-hant": "Demo Estate 雷司令 2024",
    });
    expect(payload.product.price).toBe(288);
    expect(payload.product.status).toBe(false);
    expect(payload.product.unlimited_quantity).toBe(true);
    expect(payload.product).not.toHaveProperty("quantity");
  });

  it("includes a finite quantity and disables unlimited quantity when stock is explicit", () => {
    const payload = projectToShopline({ ...canonicalListing, stockQuantity: 4 }, []);

    expect(payload.product.quantity).toBe(4);
    expect(payload.product.unlimited_quantity).toBe(false);
  });

  it("fails with a typed validation error when a price is absent", () => {
    expect(() => projectToShopline({ ...canonicalListing, priceHkd: null } as never)).toThrow(
      ShoplineValidationError,
    );
  });

  it("does not infer image URLs from asset IDs", () => {
    const payload = projectToShopline(canonicalListing);
    expect(payload.product.images).toEqual([]);
  });

  it("rejects non-HTTPS or blank image URLs", () => {
    expect(() => projectToShopline(canonicalListing, ["http://cdn.example.test/a.jpg"])).toThrow(ShoplineValidationError);

    const result = validateShoplineProduct({
      ...fixture.expectedPayload,
      product: { ...fixture.expectedPayload.product, images: ["http://cdn.example.test/a.jpg"] },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("invalid_image_url");

    expect(() => projectToShopline(canonicalListing, [" "])).toThrow(ShoplineValidationError);
  });

  it("rejects blank translations, invalid numeric values, and unsupported extra values", () => {
    const invalid = {
      ...fixture.expectedPayload,
      extra: true,
      product: {
        ...fixture.expectedPayload.product,
        price: Number.NaN,
        title_translations: { en: " ", "zh-hant": "" },
      },
    };
    const result = validateShoplineProduct(invalid);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["unsupported_field", "invalid_price", "blank_translation"]),
      );
    }
  });

  it("rejects invalid unlimited and quantity combinations", () => {
    const withQuantity = {
      ...fixture.expectedPayload,
      product: { ...fixture.expectedPayload.product, unlimited_quantity: true, quantity: 1 },
    };
    const missingQuantity = {
      ...fixture.expectedPayload,
      product: { ...fixture.expectedPayload.product, unlimited_quantity: false },
    };

    expect(validateShoplineProduct(withQuantity).valid).toBe(false);
    expect(validateShoplineProduct(missingQuantity).valid).toBe(false);
    expect(
      validateShoplineProduct({
        ...fixture.expectedPayload,
        product: { ...fixture.expectedPayload.product, unlimited_quantity: false, quantity: -1 },
      }).valid,
    ).toBe(false);
    expect(
      validateShoplineProduct({
        ...fixture.expectedPayload,
        product: { ...fixture.expectedPayload.product, unlimited_quantity: false, quantity: 1.5 },
      }).valid,
    ).toBe(false);
  });

  it("rejects titles beyond the documented fixture limit", () => {
    const tooLong = {
      ...fixture.expectedPayload,
      product: {
        ...fixture.expectedPayload.product,
        title_translations: {
          ...fixture.expectedPayload.product.title_translations,
          en: "x".repeat(fixture.limits.titleMaxLength + 1),
        },
      },
    };
    const result = validateShoplineProduct(tooLong);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.code)).toContain("title_too_long");
  });

  it("validates one product separately from duplicate SKU batches", () => {
    expect(fixture.specVersion).toBe("opak-2026-07");
    expect(validateShoplineProduct(fixture.expectedPayload).valid).toBe(true);

    const batch = validateShoplineProducts([fixture.expectedPayload, fixture.expectedPayload]);
    expect(batch.valid).toBe(false);
    if (!batch.valid) expect(batch.issues.map((issue) => issue.code)).toContain("duplicate_sku");
  });
});
