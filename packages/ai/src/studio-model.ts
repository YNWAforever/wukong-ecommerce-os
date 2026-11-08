import { z } from "zod";

import { STUDIO_PROMPT_VERSIONS } from "@wukong/core";

import type { AIUsage } from "./contracts.js";
import {
  studioComposerMessages,
  studioPlannerMessages,
  type StudioComposerPromptInput,
  type StudioPlannerPromptInput,
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
        evidenceRefs: z
          .array(z.string().trim().min(1).max(200))
          .min(1)
          .max(10),
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

export type StudioModel = {
  plan(input: StudioPlanInput): Promise<{ plan: StudioPlan; usage: AIUsage }>;
  compose(
    input: StudioComposeInput,
  ): Promise<{ analysis: StudioAnalysis; usage: AIUsage }>;
};

export type StudioModelConfig = TypedJsonCompletionConfig;

const PLAN_SCHEMA_NAME = "studio_plan";
const ANALYSIS_SCHEMA_NAME = "studio_analysis";

function validatePlan(input: StudioPlanInput) {
  return (plan: StudioPlan): void => {
    const toolIds = new Set(
      input.availableTools.map((tool) => tool.id),
    );
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

  constructor(script: {
    plans?: StudioPlan[];
    analyses?: StudioAnalysis[];
  } = {}) {
    this.plans = [...(script.plans ?? [])];
    this.analyses = [...(script.analyses ?? [])];
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
}

export type { StudioSkillPromptSummary };
