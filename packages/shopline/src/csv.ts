import { ShoplineValidationError, validateShoplineProducts } from "./validation.js";
import type { ShoplineProductPayload } from "./projection.js";

export const SHOPLINE_CSV_SPEC_VERSION = "opak-2026-07" as const;

const CSV_COLUMNS = [
  "SKU",
  "English Title",
  "Traditional Chinese Title",
  "Price",
  "Quantity",
  "Unlimited Quantity",
  "English Description",
  "Traditional Chinese Description",
  "SEO English Title",
  "SEO Traditional Chinese Title",
  "SEO English Description",
  "SEO Traditional Chinese Description",
  "Tags",
  "Images",
  "Status",
] as const;

function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function rowFor(payload: ShoplineProductPayload): string[] {
  const product = payload.product;
  return [
    product.sku,
    product.title_translations.en,
    product.title_translations["zh-hant"],
    String(product.price),
    product.quantity === undefined ? "" : String(product.quantity),
    String(product.unlimited_quantity),
    product.description_translations.en,
    product.description_translations["zh-hant"],
    product.seo_title_translations.en,
    product.seo_title_translations["zh-hant"],
    product.seo_description_translations.en,
    product.seo_description_translations["zh-hant"],
    product.tags.join(";"),
    product.images.join(";"),
    String(product.status),
  ];
}

export function createShoplineCsv(payloads: readonly ShoplineProductPayload[]): string {
  const validation = validateShoplineProducts(payloads);
  if (!validation.valid) throw new ShoplineValidationError(validation.issues);

  const rows = [CSV_COLUMNS as readonly string[], ...validation.value.map(rowFor)];
  return `${rows.map((row) => row.map(escapeCsvField).join(",")).join("\r\n")}\r\n`;
}
