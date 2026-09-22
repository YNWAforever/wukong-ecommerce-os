import {
  wineSupportProposalSchema,
  wineQualityIssueSchema,
  wineCheckResponseSchema,
  type WineFrozenContext,
  type WineGenerationCandidate,
} from "@wukong/core";
export {
  wineSupportProposalSchema,
  wineQualityIssueSchema,
  wineFrozenContextSchema,
  wineGenerationOwnershipContextSchema,
  wineGenerationRequestSchema,
  wineOutputAnnotationSchema,
  wineGenerationCandidateSchema,
  wineCheckResponseSchema,
  type WineSupportProposal,
  type WineFrozenContext,
  type WineGenerationRequest,
  type WineGenerationCandidate,
  type WineCheckRequest,
} from "@wukong/core";
import { z } from "zod";
import {
  evidenceSourceSchema,
  productIdentitySchema,
  supportedClaimSchema,
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

export type WineGenerationResult = WineGenerationCandidate & {
  status: "candidate";
  requiresQualityCheck: true;
  requiresMerchantReview: true;
  usage: AIUsage;
};
export type WineCheckResult = z.infer<typeof wineCheckResponseSchema> & {
  requiresMerchantReview: true;
  usage: AIUsage;
};
