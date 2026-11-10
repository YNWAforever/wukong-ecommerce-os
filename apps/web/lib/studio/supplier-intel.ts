import { z } from "zod";

import {
  translatedLine,
  translatedLineSchema,
  type TranslatedLine,
} from "./types";

/**
 * Supplier-intel proposal artifact contract (C1).
 *
 * The reviewed sources are the listing and its linked workbook row: the bulk
 * form import writes the canonical row into `platform_products.raw_row` and
 * links the source-import receipt, so field-level values can be quoted without
 * a model or a guess. The payload is stored as a versioned `finding` artifact
 * and is never applied; workspace-level website records are not listing-linked
 * and are deliberately not used.
 */

/** Canonical bulk-form columns this skill may quote, in display order. */
export const SUPPLIER_FIELD_COLUMNS = [
  { field: "supplier", column: "supplier" },
  { field: "brand", column: "brand" },
  { field: "sku", column: "sku" },
  { field: "barcode", column: "barcode" },
  { field: "mpn", column: "mpn" },
  { field: "productCost", column: "productCost" },
  { field: "tradePrice", column: "tradePrice" },
] as const;

export type SupplierFieldKey = (typeof SUPPLIER_FIELD_COLUMNS)[number]["field"];

export const SUPPLIER_FIELD_KEYS = SUPPLIER_FIELD_COLUMNS.map(
  (column) => column.field,
) as [SupplierFieldKey, ...SupplierFieldKey[]];

export const supplierIntelFieldSchema = z.strictObject({
  field: z.enum(SUPPLIER_FIELD_KEYS),
  value: z.string().trim().min(1).max(200),
  /** Refs into the evidence pack; every ref resolves at composition time. */
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(3),
});

export const supplierIntelProposalPayloadSchema = z.strictObject({
  schemaVersion: z.literal("wukong-supplier-intel/v1"),
  listingId: z.string().min(1).max(200),
  listingTitle: z.string().max(300),
  productId: z.string().min(1).max(200),
  fields: z.array(supplierIntelFieldSchema).max(7),
  missingFields: z.array(z.enum(SUPPLIER_FIELD_KEYS)).max(7),
  limitations: z.array(translatedLineSchema).max(10),
  asOf: z.string().min(1).max(64),
});

export type SupplierIntelProposalPayload = z.infer<
  typeof supplierIntelProposalPayloadSchema
>;

/** Deterministic facts the turn service needs to build the artifact. */
export type SupplierIntelContext = {
  listingId: string;
  listingTitle: string;
  /** Linked workbook row, or `null` when the listing has no linked import. */
  workbook: {
    productId: string;
    values: Partial<Record<SupplierFieldKey, string>>;
    missingFields: SupplierFieldKey[];
  } | null;
  sourceImport: { importId: string; receivedAt: string } | null;
  /** Every ref the deterministic payload may cite. */
  allowedEvidenceRefs: string[];
};

/** Why the deterministic slice produced what it did, as copy lines. */
export function supplierIntelLimitations(
  context: SupplierIntelContext,
): TranslatedLine[] {
  const limitations: TranslatedLine[] = [
    translatedLine("studio.limit.supplier_not_applied"),
    translatedLine("studio.limit.supplier_website_unlinked"),
  ];
  if (!context.workbook) {
    limitations.push(
      translatedLine("studio.limit.supplier_workbook_unavailable"),
    );
    return limitations;
  }
  if (!context.sourceImport) {
    limitations.push(
      translatedLine("studio.limit.supplier_source_import_unavailable"),
    );
  }
  if (context.workbook.missingFields.length > 0) {
    limitations.push(
      translatedLine("studio.limit.supplier_fields_missing", {
        fields: context.workbook.missingFields.join(","),
      }),
    );
  }
  return limitations;
}

/**
 * Build the versioned artifact payload from the deterministic context. Fields
 * are quoted only from resolved workbook values; every field cites the
 * workbook ref (and the source-import ref when the receipt exists).
 */
export function supplierIntelPayloadFromContext(
  context: SupplierIntelContext,
  asOf: Date,
): SupplierIntelProposalPayload | null {
  if (!context.workbook) return null;
  const workbookRef = `workbook:${context.workbook.productId}`;
  const evidenceRefs = context.sourceImport
    ? [workbookRef, `source_import:${context.sourceImport.importId}`]
    : [workbookRef];
  const fields = SUPPLIER_FIELD_COLUMNS.flatMap(({ field }) => {
    const value = context.workbook?.values[field];
    return value ? [{ field, value, evidenceRefs }] : [];
  });
  return supplierIntelProposalPayloadSchema.parse({
    schemaVersion: "wukong-supplier-intel/v1",
    listingId: context.listingId,
    listingTitle: context.listingTitle,
    productId: context.workbook.productId,
    fields,
    missingFields: context.workbook.missingFields,
    limitations: supplierIntelLimitations(context),
    asOf: asOf.toISOString(),
  });
}
