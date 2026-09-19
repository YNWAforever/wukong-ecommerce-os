import { z } from "zod";
import { sectionKeySchema } from "./wine-enrichment-contracts.js";
/** Compact references only. Parsing does not authorize evidence or renew source age. */
export const WINE_COPY_LIMITS = Object.freeze({
  origins: 17,
  claims: 128,
  supports: 512,
  sourcesPerClaim: 128,
  paths: 128,
  snapshotBytes: 262144,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .max(100)
  .regex(
    /^(?:(?:title|seo\.(?:title|description))\.(?:en|zh-Hant)|sections\.(?:selling_points|introduction|tasting|pairing|serving|brand_background)\.(?:en|zh-Hant)|tags\.\d+)$/,
  );
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const ids = z.array(z.uuid()).max(WINE_COPY_LIMITS.claims).refine(unique);
export const wineCopySnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    mode: z.enum(["copy", "section"]),
    section: sectionKeySchema.nullable(),
    workspaceId: z.string().min(1).max(200),
    listingId: z.uuid(),
    baseVersionId: z.uuid(),
    adoptedRunId: z.uuid(),
    inputRevision: z.number().int().nonnegative(),
    inputDigest: digest,
    sourceDigest: digest,
    currentContentDigest: digest,
    adoptedContentDigest: digest,
    ownershipDigest: digest,
    policyDigest: digest,
    modelDigest: digest,
    targetPaths: z
      .array(path)
      .min(1)
      .max(WINE_COPY_LIMITS.paths)
      .refine(unique),
    origins: z
      .array(
        z.strictObject({
          runId: z.uuid(),
          versionId: z.uuid(),
          inputRevision: z.number().int().nonnegative(),
          inputDigest: digest,
          sourceDigest: digest,
          acceptedAt: z.iso.datetime({ offset: true }),
          policyDigest: digest,
          modelDigest: digest,
          identityDigest: digest,
          frozenContextDigest: digest,
        }),
      )
      .min(1)
      .max(WINE_COPY_LIMITS.origins),
    claims: z
      .array(
        z.strictObject({
          claimId: z.uuid(),
          originRunId: z.uuid(),
          originVersionId: z.uuid(),
          claimDigest: digest,
          premiseClaimIds: ids,
          sources: z
            .array(z.strictObject({ id: z.uuid(), digest }))
            .max(WINE_COPY_LIMITS.sourcesPerClaim),
        }),
      )
      .min(1)
      .max(WINE_COPY_LIMITS.claims),
    supports: z
      .array(
        z.strictObject({
          path,
          claimId: z.uuid(),
          originRunId: z.uuid(),
          originVersionId: z.uuid(),
          textDigest: digest,
          spanDigest: digest,
        }),
      )
      .min(1)
      .max(WINE_COPY_LIMITS.supports),
    // Live-read provenance is immutable audit data, separate from replay comparison.
    adoptedProvenanceDigest: digest,
    dependencyDigest: digest,
  })
  .superRefine((s, ctx) => {
    const reject = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if ((s.mode === "section") !== (s.section !== null))
      reject("Section mode binding");
    if (
      s.section &&
      (s.targetPaths.length !== 2 ||
        !["en", "zh-Hant"].every((lang) =>
          s.targetPaths.includes(`sections.${s.section}.${lang}`),
        ))
    )
      reject("Exact section targets required");
    if (
      !unique(s.origins.map((o) => o.runId)) ||
      !unique(s.origins.map((o) => o.versionId)) ||
      !unique(s.claims.map((c) => c.claimId))
    )
      reject("Duplicate origin or claim");
    for (const c of s.claims) {
      if (
        !s.origins.some(
          (o) => o.runId === c.originRunId && o.versionId === c.originVersionId,
        )
      )
        reject("Missing claim origin");
      if (
        !unique(c.sources.map((x) => x.id)) ||
        !c.premiseClaimIds.every((id) =>
          s.claims.some(
            (p) => p.claimId === id && p.originRunId === c.originRunId,
          ),
        )
      )
        reject("Invalid claim closure");
    }
    for (const support of s.supports)
      if (
        !s.targetPaths.includes(support.path) ||
        !s.claims.some(
          (c) =>
            c.claimId === support.claimId &&
            c.originRunId === support.originRunId &&
            c.originVersionId === support.originVersionId,
        )
      )
        reject("Invalid support binding");
    if (
      new TextEncoder().encode(JSON.stringify(s)).byteLength >
      WINE_COPY_LIMITS.snapshotBytes
    )
      reject("Copy snapshot too large");
  });
export type WineCopySnapshot = z.infer<typeof wineCopySnapshotSchema>;
