import { readFileSync } from "node:fs";

import {
  SHOPLINE_BULK_FORM_SPEC_VERSION,
  parseBulkForm,
  type BulkFormParseResult,
  type BulkFormProductRow,
  type BulkFormSheet,
} from "../bulk-form.js";
import { readBulkFormSheet } from "../bulk-form-xlsx.js";

/**
 * Reads a SHOPLINE bulk update form and reports what a defensive parse hit:
 * every issue code with a count, the content gaps across the catalog, and the
 * stock and margin aggregates behind the hygiene report.
 *
 * Deliberately aggregate-only. No product name, SKU, price, or other merchant
 * content is printed, so the output can be pasted into a runbook or an issue.
 */
export type BulkFormProfile = {
  specVersion: typeof SHOPLINE_BULK_FORM_SPEC_VERSION;
  rows: number;
  issues: {
    total: number;
    errors: number;
    warnings: number;
    byCode: Record<string, number>;
  };
  gaps: Record<string, number>;
  inventory: {
    zeroStock: number;
    unlimited: number;
    hiddenOnline: number;
    retailVisible: number;
  };
  pricing: { onSale: number; withCost: number; missingPrice: number };
  productTypes: Record<string, number>;
};

const tally = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export function profileBulkForm(result: BulkFormParseResult): BulkFormProfile {
  const byCode: Record<string, number> = {};
  let errors = 0;
  for (const issue of result.issues) {
    tally(byCode, issue.code);
    if (issue.severity === "error") errors += 1;
  }

  const gaps: Record<string, number> = {};
  const productTypes: Record<string, number> = {};
  const inventory = {
    zeroStock: 0,
    unlimited: 0,
    hiddenOnline: 0,
    retailVisible: 0,
  };
  const pricing = { onSale: 0, withCost: 0, missingPrice: 0 };

  for (const row of result.rows as readonly BulkFormProductRow[]) {
    for (const [gap, present] of Object.entries(row.gaps))
      if (present) tally(gaps, gap);
    tally(productTypes, row.facts.productType ?? "unmapped");

    if (row.inventory.unlimited) inventory.unlimited += 1;
    else if (row.inventory.quantity === 0) inventory.zeroStock += 1;
    if (!row.visibility.onlineStore) inventory.hiddenOnline += 1;
    if (row.visibility.retailStore) inventory.retailVisible += 1;

    const { regular, sale, cost } = row.pricing;
    if (sale !== null && regular !== null && sale > 0 && sale < regular)
      pricing.onSale += 1;
    if (cost !== null && cost > 0) pricing.withCost += 1;
    if (row.facts.priceHkd === null) pricing.missingPrice += 1;
  }

  return {
    specVersion: result.specVersion,
    rows: result.rows.length,
    issues: {
      total: result.issues.length,
      errors,
      warnings: result.issues.length - errors,
      byCode,
    },
    gaps,
    inventory,
    pricing,
    productTypes,
  };
}

export function readSheet(path: string): BulkFormSheet {
  return readBulkFormSheet(new Uint8Array(readFileSync(path)));
}

export function main(args: readonly string[] = process.argv.slice(2)): number {
  const path = args[0];
  if (path === undefined) {
    console.error(
      "usage: pnpm --filter @wukong/shopline bulk-form:profile <bulk-update-form.xlsx>",
    );
    return 1;
  }

  try {
    const result = parseBulkForm(readSheet(path));
    console.info(
      JSON.stringify({
        event: "bulk_form_profiled",
        ...profileBulkForm(result),
      }),
    );
    return result.rows.length > 0 ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

if (
  process.argv[1]?.endsWith("profile-bulk-form.ts") ||
  process.argv[1]?.endsWith("profile-bulk-form.js")
) {
  process.exitCode = main();
}
