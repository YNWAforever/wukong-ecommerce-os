import { readFileSync, writeFileSync } from "node:fs";

import type { CanonicalListing } from "@wukong/core";

import { createShoplineCsv } from "../csv.js";
import { projectToShopline } from "../projection.js";
import { ShoplineValidationError } from "../validation.js";

type SampleFixture = {
  canonicalListing: CanonicalListing;
  imageUrls: string[];
};

// The same fixture the CSV tests assert against, read at runtime rather than
// imported because it sits outside this package's rootDir. Sharing it keeps the
// harness and the golden test describing one product, so a spec change cannot
// satisfy one and break the other.
const FIXTURE_URL = new URL(
  "../../fixtures/shopline-create-product.json",
  import.meta.url,
);

export function readSampleFixture(url: URL = FIXTURE_URL): SampleFixture {
  return JSON.parse(readFileSync(url, "utf8")) as SampleFixture;
}

// createShoplineCsv validates before emitting and throws on any issue, so the
// harness never writes a file SHOPLINE would reject.
export function createSampleCsv(imageUrls: readonly string[] = []): string {
  const fixture = readSampleFixture();
  return createShoplineCsv([
    projectToShopline(
      fixture.canonicalListing,
      imageUrls.length > 0 ? imageUrls : fixture.imageUrls,
    ),
  ]);
}

export function main(args: readonly string[] = process.argv.slice(2)): number {
  const [target = "sample-shopline.csv", ...imageUrls] = args;
  try {
    writeFileSync(target, createSampleCsv(imageUrls), "utf8");
  } catch (error) {
    if (error instanceof ShoplineValidationError) {
      console.error("the sample payload is not a valid SHOPLINE product:");
      for (const issue of error.issues)
        console.error(`- ${issue.path}: ${issue.message}`);
      return 1;
    }
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
  console.log(`wrote ${target}`);
  return 0;
}

if (
  process.argv[1]?.endsWith("sample-csv.ts") ||
  process.argv[1]?.endsWith("sample-csv.js")
) {
  process.exitCode = main();
}
