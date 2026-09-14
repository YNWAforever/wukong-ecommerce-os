/**
 * What the pipeline already knows about a listing, read back for the screen.
 *
 * When extraction ends with missing fields the run completes as `needs_info`
 * and no version is written, so the review page has nothing to show and the
 * operator is told only that information is needed -- not which information, and
 * not what the model already read off their photographs.
 *
 * None of that is actually lost. `runListingPipeline` records the extraction
 * step with its full output *before* it checks `missingFields`, so facts,
 * evidence and the missing list are already durable in
 * `listing_pipeline_steps.output`, and `pipelineRuns.getState` already returns
 * them. This module reads that back into a shape the API can serialize.
 *
 * Two things it deliberately does not do: it never surfaces `usage` (model,
 * token counts and cost belong to the admin cost ledger, not an operator's
 * product page), and it never trusts the stored JSON. That column is `jsonb`
 * with no database-level schema, and rows written by older code may not match
 * the current contract, so every field is re-parsed and anything unrecognized
 * degrades to "not available" rather than throwing on a page load.
 */
import { listingFactsSchema, type ListingFacts } from "@wukong/core";

/** The subset of `PipelineRunState` this module needs, structurally typed. */
export type PipelineRunStateLike = {
  status: "started" | "succeeded" | "failed";
  resultStatus: "in_review" | "needs_info" | null;
  errorCode: string | null;
  steps: Map<string, { state: "running" | "completed"; output: unknown }>;
};

export type ListingProcessingSummary = {
  runStatus: "started" | "succeeded" | "failed";
  resultStatus: "in_review" | "needs_info" | null;
  /** A stable code such as `provider_failure`; never a provider message. */
  errorCode: string | null;
  /** Facts read from the sources, or null when extraction never completed. */
  extractedFacts: ListingFacts | null;
  /** Field names extraction could not fill. Empty when nothing is outstanding. */
  missingFields: string[];
};

function readMissingFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Narrow one recorded extraction step into facts and missing fields.
 *
 * Returns nulls rather than throwing: a listing page that cannot render because
 * a historical run stored a shape this build no longer recognizes is a worse
 * outcome than a page that renders without the extra detail.
 */
function readExtractionStep(output: unknown): {
  facts: ListingFacts | null;
  missingFields: string[];
} {
  if (!output || typeof output !== "object") {
    return { facts: null, missingFields: [] };
  }
  const candidate = output as { facts?: unknown; missingFields?: unknown };
  const parsed = listingFactsSchema.safeParse(candidate.facts);
  return {
    facts: parsed.success ? parsed.data : null,
    missingFields: readMissingFields(candidate.missingFields),
  };
}

/**
 * Summarize a pipeline run for the listing read model.
 *
 * `null` when the listing has no run at all -- it was never enqueued, or the
 * current revision has not been processed yet.
 */
export function readProcessingSummary(
  runState: PipelineRunStateLike | null | undefined,
): ListingProcessingSummary | null {
  if (!runState) return null;
  const extracted = runState.steps?.get("extracted");
  const { facts, missingFields } =
    extracted?.state === "completed"
      ? readExtractionStep(extracted.output)
      : { facts: null, missingFields: [] };

  return {
    runStatus: runState.status,
    resultStatus: runState.resultStatus,
    errorCode: runState.errorCode,
    extractedFacts: facts,
    missingFields,
  };
}

/**
 * Fact keys an operator still has to supply themselves.
 *
 * `sku`, `priceHkd` and `stockQuantity` are merchant data the AI is not allowed
 * to read off a photograph (see fact-grounding-rules.ts), so when they are
 * outstanding they are outstanding *for a person*, not for a retry. Separating
 * them lets the screen ask for those directly instead of implying that running
 * processing again might find them.
 */
export const MERCHANT_SUPPLIED_FIELDS = [
  "sku",
  "priceHkd",
  "stockQuantity",
] as const;

export function splitMissingFields(missingFields: string[]): {
  merchant: string[];
  extractable: string[];
} {
  const merchant: string[] = [];
  const extractable: string[] = [];
  for (const field of missingFields) {
    if ((MERCHANT_SUPPLIED_FIELDS as readonly string[]).includes(field)) {
      merchant.push(field);
    } else {
      extractable.push(field);
    }
  }
  return { merchant, extractable };
}
