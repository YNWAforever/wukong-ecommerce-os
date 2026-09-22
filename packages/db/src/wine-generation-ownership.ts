import {
  workingBaselineForReview,
  type WineContent,
  type WorkingListing,
  type WorkingFieldStates,
} from "@wukong/core";
import { listingInputDigest } from "./repositories/listing-inputs.js";
type Metadata = Pick<WineContent, "title" | "seo" | "tags">;
export type WineGenerationOwnership =
  | { status: "unavailable"; code: string }
  | {
      status: "available";
      schemaVersion: 1;
      binding: {
        workspaceId: string;
        operationId: string;
        listingId: string;
        inputRevision: number;
        baseVersionId: string | null;
      };
      prior: (
        | { kind: "structured"; current: WineContent }
        | {
            kind: "legacy";
            current: null;
            description: { en: string; "zh-Hant": string };
          }
        | { kind: "empty"; current: null }
      ) & { metadata: Metadata };
      lockedPaths: string[];
      provenance: {
        inputDigest: string;
        baseVersionId: string | null;
        contentDigest: string;
      };
      provenanceDigest: string;
    };
/** Pure resolution only. Callers must authorize input and exact base before invoking. */
export function resolveWineGenerationOwnership(
  input: { inputDigest: string; fieldStates: WorkingFieldStates },
  parsed: WorkingListing,
  base: WorkingListing | undefined,
  binding: Extract<WineGenerationOwnership, { status: "available" }>["binding"],
): Extract<WineGenerationOwnership, { status: "available" }> {
  const resolved = workingBaselineForReview(parsed, input.fieldStates, base),
    content = resolved.workingContent;
  const metadata = {
    title: content.title,
    seo: content.seo,
    tags: content.tags,
  };
  const lockedPaths = Object.entries(resolved.fieldStates)
    .filter(
      ([key, state]) =>
        /^(title\.|seo\.|tags$)/.test(key) &&
        (state?.locked || state?.owner === "operator"),
    )
    .map(([key]) => key);
  const prior: Extract<
    WineGenerationOwnership,
    { status: "available" }
  >["prior"] = content.wineOwnership
    ? {
        kind: "structured",
        current: { ...metadata, sections: content.wineOwnership.sections },
        metadata,
      }
    : content.description.en !== "" || content.description["zh-Hant"] !== ""
      ? {
          kind: "legacy",
          current: null,
          metadata,
          description: content.description,
        }
      : { kind: "empty", current: null, metadata };
  if (
    prior.kind === "structured" &&
    (["description.en", "description.zh-Hant"] as const).some(
      (key) =>
        resolved.fieldStates[key]?.locked ||
        resolved.fieldStates[key]?.owner === "operator",
    )
  )
    lockedPaths.push("sections");
  if (prior.kind === "structured")
    for (const s of prior.current.sections)
      if (s.locked || s.owner === "operator")
        lockedPaths.push(`sections.${s.key}`);
  const provenance = {
    inputDigest: input.inputDigest,
    baseVersionId: binding.baseVersionId,
    contentDigest: listingInputDigest({
      content,
      fieldStates: resolved.fieldStates,
    }),
  };
  const value = {
    status: "available" as const,
    schemaVersion: 1 as const,
    binding,
    prior,
    lockedPaths: lockedPaths.sort(),
    provenance,
  };
  return { ...value, provenanceDigest: listingInputDigest(value) };
}
