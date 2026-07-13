import type { CanonicalListing } from "@wukong/core";

import { ShoplineValidationError, validateShoplineProduct } from "./validation.js";

export type ShoplineTranslations = {
  en: string;
  "zh-hant": string;
};

export type ShoplineProduct = {
  sku: string;
  price: number;
  quantity?: number;
  unlimited_quantity: boolean;
  title_translations: ShoplineTranslations;
  description_translations: ShoplineTranslations;
  seo_title_translations: ShoplineTranslations;
  seo_description_translations: ShoplineTranslations;
  tags: string[];
  images: string[];
  status: false;
};

export type ShoplineProductPayload = {
  product: ShoplineProduct;
};

/**
 * Maps the platform-neutral listing into the versioned SHOPLINE product shape.
 * Image URLs are intentionally accepted only as an explicit second argument;
 * asset IDs are not converted into URLs by this boundary.
 */
export function projectToShopline(
  listing: CanonicalListing,
  imageUrls: readonly string[] = [],
): ShoplineProductPayload {
  const source = listing as unknown as Record<string, unknown>;
  const title = (source.title ?? {}) as Record<string, unknown>;
  const description = (source.description ?? {}) as Record<string, unknown>;
  const seo = (source.seo ?? {}) as Record<string, unknown>;
  const seoTitle = (seo.title ?? {}) as Record<string, unknown>;
  const seoDescription = (seo.description ?? {}) as Record<string, unknown>;
  const stockQuantity = source.stockQuantity;

  const payload = {
    product: {
      sku: source.sku,
      price: source.priceHkd,
      ...(stockQuantity === null ? {} : { quantity: stockQuantity }),
      unlimited_quantity: stockQuantity === null,
      title_translations: { en: title.en, "zh-hant": title["zh-Hant"] },
      description_translations: { en: description.en, "zh-hant": description["zh-Hant"] },
      seo_title_translations: { en: seoTitle.en, "zh-hant": seoTitle["zh-Hant"] },
      seo_description_translations: { en: seoDescription.en, "zh-hant": seoDescription["zh-Hant"] },
      tags: source.tags,
      images: [...imageUrls],
      status: false as const,
    },
  } as unknown;

  const validation = validateShoplineProduct(payload);
  if (!validation.valid) throw new ShoplineValidationError(validation.issues);
  return validation.value;
}
