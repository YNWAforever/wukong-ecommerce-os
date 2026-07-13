import type { ShoplineProductPayload } from "./projection.js";

export const SHOPLINE_TITLE_MAX_LENGTH = 255;

export type ShoplineValidationIssue = {
  code:
  | "blank_translation"
  | "duplicate_sku"
  | "empty_batch"
  | "invalid_image_url"
  | "invalid_price"
  | "invalid_quantity"
  | "invalid_sku"
  | "invalid_unlimited_quantity"
  | "invalid_status"
  | "invalid_tags"
  | "invalid_shape"
  | "title_too_long"
  | "unsupported_field";
  path: string;
  message: string;
};

export type ShoplineValidationResult =
  | { valid: true; value: ShoplineProductPayload }
  | { valid: false; issues: ShoplineValidationIssue[] };

export type ShoplineBatchValidationResult =
  | { valid: true; value: ShoplineProductPayload[] }
  | { valid: false; issues: ShoplineValidationIssue[] };

export class ShoplineValidationError extends Error {
  readonly issues: ShoplineValidationIssue[];

  constructor(issues: ShoplineValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "ShoplineValidationError";
    this.issues = issues;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function issue(
  code: ShoplineValidationIssue["code"],
  path: string,
  message: string,
): ShoplineValidationIssue {
  return { code, path, message };
}

function validateExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => issue("unsupported_field", `${path}.${key}`, "field is not supported by this SHOPLINE contract"));
}

function validateTranslations(value: unknown, path: string, title: boolean): ShoplineValidationIssue[] {
  if (!isRecord(value)) return [issue("invalid_shape", path, "translations must be an object")];
  const issues = validateExactKeys(value, ["en", "zh-hant"], path);
  for (const locale of ["en", "zh-hant"] as const) {
    const translation = value[locale];
    if (typeof translation !== "string" || translation.trim().length === 0) {
      issues.push(issue("blank_translation", `${path}.${locale}`, "translation must not be blank"));
    } else if (title && translation.length > SHOPLINE_TITLE_MAX_LENGTH) {
      issues.push(issue("title_too_long", `${path}.${locale}`, `title must be at most ${SHOPLINE_TITLE_MAX_LENGTH} characters`));
    }
  }
  return issues;
}

function validateProduct(value: unknown, path: string): ShoplineValidationIssue[] {
  if (!isRecord(value)) return [issue("invalid_shape", path, "product payload must be an object")];

  const issues = validateExactKeys(
    value,
    [
      "sku",
      "price",
      "quantity",
      "unlimited_quantity",
      "title_translations",
      "description_translations",
      "seo_title_translations",
      "seo_description_translations",
      "tags",
      "images",
      "status",
    ],
    path,
  );

  if (typeof value.sku !== "string" || value.sku.trim().length === 0) {
    issues.push(issue("invalid_sku", `${path}.sku`, "SKU must be a non-blank string"));
  }
  if (typeof value.price !== "number" || !Number.isFinite(value.price) || value.price < 0) {
    issues.push(issue("invalid_price", `${path}.price`, "price must be a finite, non-negative number"));
  }

  if (typeof value.unlimited_quantity !== "boolean") {
    issues.push(issue("invalid_unlimited_quantity", `${path}.unlimited_quantity`, "unlimited_quantity must be boolean"));
  } else if (value.unlimited_quantity && Object.prototype.hasOwnProperty.call(value, "quantity")) {
    issues.push(issue("invalid_quantity", `${path}.quantity`, "quantity must be omitted when unlimited_quantity is true"));
  } else if (!value.unlimited_quantity && (typeof value.quantity !== "number" || !Number.isInteger(value.quantity) || value.quantity < 0)) {
    issues.push(issue("invalid_quantity", `${path}.quantity`, "quantity must be a non-negative integer when unlimited_quantity is false"));
  }

  if (value.status !== false) issues.push(issue("invalid_status", `${path}.status`, "status must be false for a draft product"));

  issues.push(...validateTranslations(value.title_translations, `${path}.title_translations`, true));
  issues.push(...validateTranslations(value.description_translations, `${path}.description_translations`, false));
  issues.push(...validateTranslations(value.seo_title_translations, `${path}.seo_title_translations`, true));
  issues.push(...validateTranslations(value.seo_description_translations, `${path}.seo_description_translations`, false));

  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag.trim().length === 0)) {
    issues.push(issue("invalid_tags", `${path}.tags`, "tags must be an array of non-blank strings"));
  }

  if (!Array.isArray(value.images)) {
    issues.push(issue("invalid_image_url", `${path}.images`, "images must be an array of HTTPS URLs"));
  } else {
    value.images.forEach((image, index) => {
      if (typeof image !== "string" || image.trim().length === 0) {
        issues.push(issue("invalid_image_url", `${path}.images[${index}]`, "image URL must not be blank"));
        return;
      }
      try {
        if (new URL(image).protocol !== "https:") throw new Error("protocol");
      } catch {
        issues.push(issue("invalid_image_url", `${path}.images[${index}]`, "image URL must use HTTPS"));
      }
    });
  }

  return issues;
}

export function validateShoplineProduct(value: unknown): ShoplineValidationResult {
  if (!isRecord(value)) return { valid: false, issues: [issue("invalid_shape", "payload", "payload must be an object")] };

  const issues = validateExactKeys(value, ["product"], "payload");
  issues.push(...validateProduct(value.product, "payload.product"));
  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, value: value as ShoplineProductPayload };
}

export function validateShoplineProducts(values: readonly unknown[]): ShoplineBatchValidationResult {
  if (values.length === 0) return { valid: false, issues: [issue("empty_batch", "products", "at least one product is required")] };

  const issues: ShoplineValidationIssue[] = [];
  const validValues: ShoplineProductPayload[] = [];
  const skuIndexes = new Map<string, number>();

  values.forEach((value, index) => {
    const result = validateShoplineProduct(value);
    if (!result.valid) {
      issues.push(
        ...result.issues.map((current) => ({
          ...current,
          path: `products[${index}].${current.path.replace(/^payload\.?/, "")}`.replace(/\.$/, ""),
        })),
      );
      return;
    }
    validValues.push(result.value);
    const sku = result.value.product.sku;
    const firstIndex = skuIndexes.get(sku);
    if (firstIndex !== undefined) {
      issues.push(issue("duplicate_sku", `products[${index}].product.sku`, `SKU duplicates products[${firstIndex}]`));
    } else {
      skuIndexes.set(sku, index);
    }
  });

  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, value: validValues };
}
