import { z } from "zod";

import { STUDIO_PROMPT_VERSIONS } from "@wukong/core";

import type { AIUsage } from "./contracts.js";
import {
  STUDIO_COPY_PROPOSAL_FIELDS,
  studioComposerMessages,
  studioPlannerMessages,
  studioProposerMessages,
  type StudioComposerPromptInput,
  type StudioCopyProposalField,
  type StudioPlannerPromptInput,
  type StudioProposerPromptInput,
  type StudioSkillPromptSummary,
} from "./studio-prompts.js";
import {
  TypedJsonCompletionClient,
  type TypedJsonCompletionConfig,
} from "./typed-json-completion.js";

/**
 * Typed two-call model port for the Conversation Studio (plan Task 8).
 *
 * There is no free-form chat: the planner returns a validated plan and the
 * composer returns validated sections/claims. The web turn service resolves
 * every claim's evidenceRef against the pack and drops anything ungrounded.
 * Streaming is intentionally absent in v1.
 */

export const studioToolRequestSchema = z.strictObject({
  toolId: z.string().trim().min(1).max(120),
  arguments: z.record(z.string(), z.unknown()),
});
export type StudioToolRequest = z.infer<typeof studioToolRequestSchema>;

export const studioPlanSchema = z.strictObject({
  skillKey: z.string().trim().min(1).max(120).nullable(),
  missingInputs: z.array(z.string().trim().min(1).max(80)).max(8),
  toolRequests: z.array(studioToolRequestSchema).max(3),
  clarification: z.string().trim().min(1).max(500).nullable(),
});
export type StudioPlan = z.infer<typeof studioPlanSchema>;

export const studioAnalysisSchema = z.strictObject({
  sections: z
    .array(
      z.strictObject({
        heading: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(4000),
      }),
    )
    .min(1)
    .max(8),
  claims: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(2000),
        evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
      }),
    )
    .max(30),
  limitations: z.array(z.string().trim().min(1).max(500)).max(10),
  followUps: z.array(z.string().trim().min(1).max(200)).max(6),
  clarification: z.string().trim().min(1).max(500).nullable(),
});
export type StudioAnalysis = z.infer<typeof studioAnalysisSchema>;

export type StudioPlanInput = StudioPlannerPromptInput;
export type StudioComposeInput = StudioComposerPromptInput;
export type StudioProposeInput = StudioProposerPromptInput;

export const studioProposalFieldSchema = z.strictObject({
  field: z.enum(STUDIO_COPY_PROPOSAL_FIELDS),
  current: z.string().max(4000).nullable(),
  proposed: z.string().trim().min(1).max(4000),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
});
export type StudioProposalField = z.infer<typeof studioProposalFieldSchema>;

export const studioCopyProposalSchema = z.strictObject({
  listingId: z.string().trim().min(1).max(200),
  activeVersionId: z.string().trim().min(1).max(200),
  activeVersionSequence: z.number().int().min(1),
  fields: z.array(studioProposalFieldSchema).min(1).max(8),
  limitations: z.array(z.string().trim().min(1).max(500)).max(10),
});
export type StudioCopyProposal = z.infer<typeof studioCopyProposalSchema>;

export type StudioModel = {
  plan(input: StudioPlanInput): Promise<{ plan: StudioPlan; usage: AIUsage }>;
  compose(
    input: StudioComposeInput,
  ): Promise<{ analysis: StudioAnalysis; usage: AIUsage }>;
  propose(
    input: StudioProposeInput,
  ): Promise<{ proposal: StudioCopyProposal; usage: AIUsage }>;
};

export type StudioModelConfig = TypedJsonCompletionConfig;

const PLAN_SCHEMA_NAME = "studio_plan";
const ANALYSIS_SCHEMA_NAME = "studio_analysis";
const PROPOSAL_SCHEMA_NAME = "studio_copy_proposal";

function validatePlan(input: StudioPlanInput) {
  return (plan: StudioPlan): void => {
    const toolIds = new Set(input.availableTools.map((tool) => tool.id));
    for (const request of plan.toolRequests)
      if (!toolIds.has(request.toolId))
        throw new Error("studio_plan_out_of_allowlist_tool");
    if (plan.missingInputs.length > 0 && plan.clarification === null)
      throw new Error("studio_plan_missing_clarification");
  };
}

function validateAnalysis() {
  return (analysis: StudioAnalysis): void => {
    for (const claim of analysis.claims)
      if (claim.evidenceRefs.length === 0)
        throw new Error("studio_analysis_ungrounded_claim");
  };
}

function validateProposal(input: StudioProposeInput) {
  return (proposal: StudioCopyProposal): void => {
    // The model may not retarget the proposal: identity comes from the
    // reviewed evidence pack, never from model output.
    if (proposal.listingId !== input.listing.listingId)
      throw new Error("studio_proposal_wrong_listing");
    if (proposal.activeVersionId !== input.listing.activeVersionId)
      throw new Error("studio_proposal_wrong_version");
    if (proposal.activeVersionSequence !== input.listing.activeVersionSequence)
      throw new Error("studio_proposal_wrong_sequence");
    const allowed = new Set<string>(input.allowedFields);
    const seen = new Set<string>();
    for (const field of proposal.fields) {
      if (!allowed.has(field.field))
        throw new Error("studio_proposal_field_not_allowed");
      if (seen.has(field.field))
        throw new Error("studio_proposal_duplicate_field");
      seen.add(field.field);
      if (field.evidenceRefs.length === 0)
        throw new Error("studio_proposal_ungrounded_field");
    }
  };
}

export function createStudioModel(config: StudioModelConfig): StudioModel {
  // Construct eagerly so an invalid backend/model/session fails at boot,
  // before the first paid turn can be attempted.
  const client = new TypedJsonCompletionClient(config);
  return {
    async plan(input) {
      const { parsed, usage } = await client.complete(
        studioPlannerMessages(input),
        studioPlanSchema,
        PLAN_SCHEMA_NAME,
        STUDIO_PROMPT_VERSIONS.planner,
        validatePlan(input),
      );
      return { plan: parsed, usage };
    },
    async compose(input) {
      const { parsed, usage } = await client.complete(
        studioComposerMessages(input),
        studioAnalysisSchema,
        ANALYSIS_SCHEMA_NAME,
        STUDIO_PROMPT_VERSIONS.composer,
        validateAnalysis(),
      );
      return { analysis: parsed, usage };
    },
    async propose(input) {
      const { parsed, usage } = await client.complete(
        studioProposerMessages(input),
        studioCopyProposalSchema,
        PROPOSAL_SCHEMA_NAME,
        STUDIO_PROMPT_VERSIONS.proposer,
        validateProposal(input),
      );
      return { proposal: parsed, usage };
    },
  };
}

export function fakeStudioUsage(overrides: Partial<AIUsage> = {}): AIUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.01,
    latencyMs: 10,
    model: "fake-studio-model",
    promptVersion: "1.0.0",
    ...overrides,
  };
}

/** Deterministic scripted model for tests; never calls a provider. */
export class FakeStudioModel implements StudioModel {
  private readonly plans: StudioPlan[];
  private readonly analyses: StudioAnalysis[];
  private readonly proposals: StudioCopyProposal[];

  constructor(
    script: {
      plans?: StudioPlan[];
      analyses?: StudioAnalysis[];
      proposals?: StudioCopyProposal[];
    } = {},
  ) {
    this.plans = [...(script.plans ?? [])];
    this.analyses = [...(script.analyses ?? [])];
    this.proposals = [...(script.proposals ?? [])];
  }

  async plan(
    input: StudioPlanInput,
  ): Promise<{ plan: StudioPlan; usage: AIUsage }> {
    validatePlan(input)(
      this.plans[0] ?? {
        skillKey: null,
        missingInputs: [],
        toolRequests: [],
        clarification: null,
      },
    );
    const plan = this.plans.shift() ?? {
      skillKey: null,
      missingInputs: [],
      toolRequests: [],
      clarification: null,
    };
    return { plan, usage: fakeStudioUsage() };
  }

  async compose(): Promise<{
    analysis: StudioAnalysis;
    usage: AIUsage;
  }> {
    const analysis = this.analyses.shift() ?? {
      sections: [{ heading: "Summary", body: "Scripted analysis." }],
      claims: [],
      limitations: [],
      followUps: [],
      clarification: null,
    };
    validateAnalysis()(analysis);
    return { analysis, usage: fakeStudioUsage() };
  }

  async propose(input: StudioProposeInput): Promise<{
    proposal: StudioCopyProposal;
    usage: AIUsage;
  }> {
    const proposal = this.proposals.shift() ?? {
      listingId: input.listing.listingId,
      activeVersionId: input.listing.activeVersionId,
      activeVersionSequence: input.listing.activeVersionSequence,
      fields: [],
      limitations: [],
    };
    validateProposal(input)(proposal);
    return { proposal, usage: fakeStudioUsage() };
  }
}

export type { StudioSkillPromptSummary };
