import { z } from "zod";
import {
  evidenceSourceSchema,
  productIdentitySchema,
  supportedClaimSchema,
  wineContentSchema,
  sectionKeySchema,
} from "./wine-enrichment-contracts.js";
import { wineSourceAuthoritySchema } from "./wine-source-authority.js";
export const wineSupportProposalSchema = z
  .object({
    sourceId: z.uuid(),
    field: supportedClaimSchema.shape.field,
    value: supportedClaimSchema.shape.value,
    span: z.string().min(1).max(16000),
    originalAuthority: z.string().min(1).optional(),
    applicableVintage:
      productIdentitySchema.options[0].shape.vintage.optional(),
  })
  .strict();
export type WineSupportProposal = z.infer<typeof wineSupportProposalSchema>;
export const wineQualityIssueSchema = z
  .object({
    path: z.string().min(1),
    code: z.string().min(1),
    blocking: z.boolean(),
    evidenceIds: z.array(z.uuid()),
  })
  .strict();
/** Trusted SERVER input only. JSON parsing does not confer trust. Task 8 must bind this to
 * the immutable tenant/operation/revision and independently validate semantic field association.
 * Never populate supports/authorities/trust sets from raw provider output. Keep contrary sources. */
export const wineFrozenContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: z
      .object({
        workspaceId: z.string().min(1),
        operationId: z.string().min(1),
        inputRevision: z.number().int().nonnegative(),
      })
      .strict(),
    identity: productIdentitySchema,
    sources: z.array(evidenceSourceSchema),
    supports: z.array(wineSupportProposalSchema),
    authorities: z.array(wineSourceAuthoritySchema),
    reliableSourceIds: z.array(z.uuid()),
    trustedObservationSourceIds: z.array(z.uuid()),
    acceptedPremises: z.array(supportedClaimSchema),
    verifiedAliases: z.array(
      z
        .object({
          producer: z.string().min(1),
          canonicalName: z.string().min(1),
          alias: z.string().min(1),
        })
        .strict(),
    ),
    lockedFields: z.array(z.string().min(1)),
    now: z.iso.datetime({ offset: true }),
  })
  .strict();
export type WineFrozenContext = z.infer<typeof wineFrozenContextSchema>;
/** Server-owned accepted claims and lock snapshot, bound to the immutable operation. */
export const wineGenerationOwnershipContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    priorKind: z.enum(["structured", "legacy", "empty"]),
    metadata: wineContentSchema.omit({ sections: true }),
    legacyDescription: z
      .object({ en: z.string(), "zh-Hant": z.string() })
      .strict()
      .nullable(),
    lockedPaths: z.array(z.string().min(1)),
    provenanceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (v) => (v.priorKind === "legacy") === (v.legacyDescription !== null),
    "Legacy description binding",
  );
export const wineGenerationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: wineFrozenContextSchema.shape.binding,
    claims: z.array(supportedClaimSchema),
    current: wineContentSchema.nullable(),
    ownership: wineGenerationOwnershipContextSchema.optional(),
    lockedPaths: z.array(z.string().min(1)),
    tone: z.string(),
    claimPolicy: z.array(z.string()),
    section: sectionKeySchema.nullable(),
  })
  .strict();
export type WineGenerationRequest = z.infer<typeof wineGenerationRequestSchema>;
export const wineOutputAnnotationSchema = z
  .object({
    path: z.string().min(1),
    span: z.string().min(1),
    claimId: z.uuid(),
    value: supportedClaimSchema.shape.value,
    evidenceIds: z.array(z.uuid()),
    premiseClaimIds: z.array(z.uuid()),
  })
  .strict();
export const wineGenerationCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    content: wineContentSchema,
    annotations: z.array(wineOutputAnnotationSchema),
  })
  .strict();
export type WineGenerationCandidate = z.infer<
  typeof wineGenerationCandidateSchema
>;
export const wineCheckResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    issues: z.array(wineQualityIssueSchema),
  })
  .strict();
export type WineCheckRequest = {
  request: WineGenerationRequest;
  candidate: WineGenerationCandidate;
};
