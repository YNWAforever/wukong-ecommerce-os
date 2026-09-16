import { z } from "zod";
import {
  evidenceSourceSchema,
  productIdentitySchema,
  supportedClaimSchema,
  wineSourceAuthoritySchema,
  type ProductIdentity,
  type SupportedClaim,
} from "@wukong/core";
import type { AIUsage } from "./contracts.js";
import type { PhysicalInvocationObserver } from "./listing-provider-errors.js";
import type { TypedJsonCompletionConfig } from "./typed-json-completion.js";
import type {
  WineExecutionSnapshot,
  WineLogicalStage,
  WineRole,
} from "./wine-enrichment-prompts.js";
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
export const wineExtractionSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: productIdentitySchema,
    evidence: z.array(evidenceSourceSchema),
  })
  .strict();
export type WineExtraction = z.infer<typeof wineExtractionSchema> & {
  usage: AIUsage;
};
const {
  state: _state,
  reason: _reason,
  ...claimProposalFields
} = supportedClaimSchema.shape;
const claimProposalSchema = z.object(claimProposalFields).strict();
export const wineVerificationProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidates: z.array(productIdentitySchema),
    claims: z.array(claimProposalSchema),
    supportProposals: z.array(wineSupportProposalSchema),
    needsDeepSearch: z.boolean(),
    issues: z.array(wineQualityIssueSchema),
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
export type WineVerificationRequest = {
  context: WineFrozenContext;
  stage: "verification" | "verification_deep";
};
export type WineVerificationResult = Omit<
  z.infer<typeof wineVerificationProposalSchema>,
  "claims"
> & { identity: ProductIdentity; claims: SupportedClaim[]; usage: AIUsage };
export type WineObserverCoordinate = {
  stage: WineLogicalStage;
  role: WineRole;
  promptVersion: string;
};
/** 6c must durably record started before I/O and fence current run/revision/deadline.
 * Physical ordinal is 1=request, 2=repair WITHIN this distinct logical stage. */
export type WineObserverFactory = (
  coordinate: WineObserverCoordinate,
) => PhysicalInvocationObserver;
export type WineEnrichmentProviderConfig = Omit<
  TypedJsonCompletionConfig,
  "backend" | "model" | "maxOutputTokens" | "invocationObserver" | "sessionId"
> & {
  sessionId: string;
  snapshot: WineExecutionSnapshot;
  observerFactory?: WineObserverFactory;
};

import { wineContentSchema, sectionKeySchema } from "@wukong/core";
/** Server-owned accepted claims and lock snapshot, bound to the immutable operation. */
export const wineGenerationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: wineFrozenContextSchema.shape.binding,
    claims: z.array(supportedClaimSchema),
    current: wineContentSchema.nullable(),
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
export type WineGenerationResult = WineGenerationCandidate & {
  status: "candidate";
  requiresQualityCheck: true;
  requiresMerchantReview: true;
  usage: AIUsage;
};
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
export type WineCheckResult = z.infer<typeof wineCheckResponseSchema> & {
  requiresMerchantReview: true;
  usage: AIUsage;
};
