import type {
  StudioAiSettings,
  StudioSettings,
  StudioSettingsInput,
} from "@wukong/db";
import {
  getSkill,
  SKILL_DEFINITIONS,
  studioTurnReservation,
  type StudioAiPolicy,
} from "@wukong/core";
import { z } from "zod";

import { ApiError } from "../route-support";
import { isStudioFeatureFlagOn } from "../studio-flags";
import { requireStudioSession, type StudioSessionDeps } from "./session";

/**
 * Workspace Studio settings administration (A1).
 *
 * This is the audited replacement for hand-written SQL in the conversation
 * studio runbook: an admin/owner can read and update the single
 * `studio_workspace_settings` row through a strict, validated API. The row is
 * still enforced by the same fail-closed gates everywhere else, so this module
 * grants no new authority — it only makes the existing configuration path
 * reviewable and auditable.
 *
 * Validation rules:
 *  - strict request shape; unknown keys are rejected;
 *  - `allowedSkills` may only name reviewed `pilot` skills (empty = all);
 *  - budgets are non-negative decimal strings, monthly <= 100 USD, and a run
 *    ceiling always requires a monthly budget at least as large;
 *  - retention is null or 1..365 days;
 *  - the AI block is all-or-none, must name a provider/model pair from the
 *    reviewed cost registry, must not price below the reviewed bound, must not
 *    claim a token context larger than the model's, and must have a run
 *    ceiling / monthly budget that covers the reviewed reservation.
 * When the AI block is null/absent the workspace stays deterministic-only.
 */

/** Upper bound on a workspace's monthly model budget, in USD. */
export const STUDIO_MONTHLY_BUDGET_MAX_USD = 100;
/** Upper bound on thread retention, in days (null means "no policy"). */
export const STUDIO_RETENTION_DAYS_MAX = 365;
/** Reviewed maximum output tokens for a Studio model call. */
export const STUDIO_MAX_OUTPUT_TOKENS = 16_384;

const MONEY_6DP = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;
const PRICE_4DP = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/;

/**
 * Mirror of the reviewed Studio model entries in
 * `packages/core/src/paid-listing-policy.ts`.
 *
 * The registry itself only exposes `getReviewedModelCostBound`, not the list,
 * and a settings form needs options. The mirror is deliberately the *smallest*
 * useful list: it is pinned by a test that proves every entry passes the real
 * `studioTurnReservation` admission, and the runtime validation below still
 * calls that reviewed function with the submitted values, so a stale mirror
 * can only ever offer a model that admission then rejects — never accept a
 * pair the registry does not know.
 */
export type ReviewedStudioModel = {
  provider: StudioAiPolicy["provider"];
  model: string;
  contextTokens: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export const REVIEWED_STUDIO_MODELS: readonly ReviewedStudioModel[] =
  Object.freeze([
    Object.freeze({
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      contextTokens: 1_048_576,
      inputUsdPerMillion: 0.3,
      outputUsdPerMillion: 1.2,
    }),
  ]);

function reviewedModel(
  provider: string,
  model: string,
): ReviewedStudioModel | undefined {
  return REVIEWED_STUDIO_MODELS.find(
    (entry) => entry.provider === provider && entry.model === model,
  );
}

const optionalMoney = z.string().trim().regex(MONEY_6DP).nullable();

const aiSettingsSchema = z
  .strictObject({
    provider: z.enum(["openrouter", "opencode-go"]),
    model: z.string().trim().min(1).max(200),
    pricingVersion: z.string().trim().min(1).max(128),
    maxInputTokens: z.number().int().positive().max(10_000_000),
    inputUsdPerMillion: z.string().trim().regex(PRICE_4DP),
    outputUsdPerMillion: z.string().trim().regex(PRICE_4DP),
    maxOutputTokens: z.number().int().positive().max(STUDIO_MAX_OUTPUT_TOKENS),
  })
  .nullable()
  .optional();

export const updateStudioSettingsBodySchema = z.strictObject({
  enabled: z.boolean(),
  allowedSkills: z
    .array(z.string().trim().min(1).max(120))
    .max(SKILL_DEFINITIONS.length),
  monthlyBudgetUsd: optionalMoney,
  runCeilingUsd: optionalMoney,
  retentionDays: z
    .number()
    .int()
    .min(1)
    .max(STUDIO_RETENTION_DAYS_MAX)
    .nullable(),
  defaultHome: z.boolean(),
  /** Absent or null keeps the workspace deterministic-only. */
  ai: aiSettingsSchema,
});
export type UpdateStudioSettingsBody = z.infer<
  typeof updateStudioSettingsBodySchema
>;

export type StudioSettingsAdminView = {
  settings: {
    enabled: boolean;
    allowedSkills: string[];
    monthlyBudgetUsd: string | null;
    runCeilingUsd: string | null;
    retentionDays: number | null;
    defaultHome: boolean;
    ai: StudioAiSettings | null;
    updatedBy: string | null;
    updatedAt: string | null;
  };
  readiness: {
    deploymentFlagOn: boolean;
    aiFlagOn: boolean;
    workspaceEnabled: boolean;
    studioEnabled: boolean;
    modelConfigured: boolean;
    budgetsPresent: boolean;
    reviewedModels: ReviewedStudioModel[];
    pilotSkills: Array<{
      key: string;
      version: string;
      title: { "zh-Hant": string; en: string };
    }>;
    limits: {
      monthlyBudgetMaxUsd: number;
      retentionDaysMax: number;
      maxOutputTokens: number;
    };
  };
};

function flagOn(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] === "true";
}

/** Honest readiness view; used by GET, PATCH and the settings page. */
export function studioSettingsAdminView(
  settings: StudioSettings,
  env: NodeJS.ProcessEnv = process.env,
): StudioSettingsAdminView {
  const deploymentFlagOn = isStudioFeatureFlagOn(env);
  const ai = settings.ai;
  return {
    settings: {
      enabled: settings.enabled,
      allowedSkills: [...settings.allowedSkills],
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
      runCeilingUsd: settings.runCeilingUsd,
      retentionDays: settings.retentionDays,
      defaultHome: settings.defaultHome,
      ai: ai
        ? {
            provider: ai.provider,
            model: ai.model,
            pricingVersion: ai.pricingVersion,
            maxInputTokens: ai.maxInputTokens,
            inputUsdPerMillion: ai.inputUsdPerMillion,
            outputUsdPerMillion: ai.outputUsdPerMillion,
            maxOutputTokens: ai.maxOutputTokens,
          }
        : null,
      updatedBy: settings.updatedBy,
      updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
    },
    readiness: {
      deploymentFlagOn,
      aiFlagOn: flagOn(env, "CONVERSATION_STUDIO_AI_ENABLED"),
      workspaceEnabled: settings.enabled,
      studioEnabled: deploymentFlagOn && settings.enabled,
      modelConfigured: ai !== null,
      budgetsPresent:
        settings.monthlyBudgetUsd !== null && settings.runCeilingUsd !== null,
      reviewedModels: REVIEWED_STUDIO_MODELS.map((entry) => ({ ...entry })),
      pilotSkills: SKILL_DEFINITIONS.filter(
        (skill) => skill.status === "pilot",
      ).map((skill) => ({
        key: skill.key,
        version: skill.version,
        title: {
          "zh-Hant": skill.title["zh-Hant"],
          en: skill.title.en,
        },
      })),
      limits: {
        monthlyBudgetMaxUsd: STUDIO_MONTHLY_BUDGET_MAX_USD,
        retentionDaysMax: STUDIO_RETENTION_DAYS_MAX,
        maxOutputTokens: STUDIO_MAX_OUTPUT_TOKENS,
      },
    },
  };
}

function invalid(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

/** Validate one admin update and turn it into the repository input shape. */
export function parseStudioSettingsUpdate(raw: unknown): StudioSettingsInput {
  const parsed = updateStudioSettingsBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid("invalid_settings", "Workspace settings are invalid.");
  }
  const body = parsed.data;

  const allowedSkills: string[] = [];
  for (const key of body.allowedSkills) {
    const skill = getSkill(key);
    if (!skill || skill.status !== "pilot") {
      throw invalid(
        "unknown_skill",
        "Allowed skills must name reviewed pilot skills.",
      );
    }
    if (!allowedSkills.includes(key)) allowedSkills.push(key);
  }

  const monthly = body.monthlyBudgetUsd;
  const ceiling = body.runCeilingUsd;
  if (monthly !== null && Number(monthly) > STUDIO_MONTHLY_BUDGET_MAX_USD) {
    throw invalid(
      "invalid_budget",
      `The monthly budget may not exceed ${STUDIO_MONTHLY_BUDGET_MAX_USD} USD.`,
    );
  }
  if (ceiling !== null) {
    if (monthly === null) {
      throw invalid(
        "invalid_budget",
        "A run ceiling requires a monthly budget.",
      );
    }
    if (Number(ceiling) > Number(monthly)) {
      throw invalid(
        "invalid_budget",
        "The run ceiling may not exceed the monthly budget.",
      );
    }
  }

  let ai: StudioAiSettings | null = null;
  if (body.ai) {
    const reviewed = reviewedModel(body.ai.provider, body.ai.model);
    if (!reviewed) {
      throw invalid(
        "ai_not_reviewed",
        "The provider and model are not in the reviewed cost registry.",
      );
    }
    if (body.ai.maxInputTokens > reviewed.contextTokens) {
      throw invalid(
        "ai_tokens_above_model_context",
        "The token context may not exceed the reviewed model maximum.",
      );
    }
    if (monthly === null || ceiling === null) {
      throw invalid(
        "ai_budget_missing",
        "Live model configuration requires a monthly budget and a run ceiling.",
      );
    }
    const policy: StudioAiPolicy = {
      provider: body.ai.provider,
      model: body.ai.model,
      pricingVersion: body.ai.pricingVersion,
      runCeilingUsd: ceiling,
      budgetCapUsd: monthly,
      maxInputTokens: body.ai.maxInputTokens,
      inputUsdPerMillion: Number(body.ai.inputUsdPerMillion),
      outputUsdPerMillion: Number(body.ai.outputUsdPerMillion),
      maxOutputTokens: body.ai.maxOutputTokens,
    };
    try {
      // Reviewed admission is authoritative: unknown pairs, below-bound
      // pricing and a budget/ceiling too small for the conservative hold all
      // fail here, exactly as they would on the first live turn.
      studioTurnReservation(policy);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (reason === "unverified_model_budget_bound") {
        throw invalid(
          "ai_pricing_below_bound",
          "The reviewed price or token bound is higher than the supplied values.",
        );
      }
      if (reason === "run_ceiling_too_small") {
        throw invalid(
          "ai_run_ceiling_too_small",
          "The run ceiling is below the reviewed per-turn hold.",
        );
      }
      if (reason === "budget_cap_too_small") {
        throw invalid(
          "ai_monthly_budget_too_small",
          "The monthly budget is below the reviewed per-turn hold.",
        );
      }
      throw invalid("invalid_settings", "The AI configuration is invalid.");
    }
    ai = {
      provider: body.ai.provider,
      model: body.ai.model,
      pricingVersion: body.ai.pricingVersion,
      maxInputTokens: body.ai.maxInputTokens,
      inputUsdPerMillion: body.ai.inputUsdPerMillion,
      outputUsdPerMillion: body.ai.outputUsdPerMillion,
      maxOutputTokens: body.ai.maxOutputTokens,
    };
  }

  return {
    enabled: body.enabled,
    allowedSkills,
    monthlyBudgetUsd: monthly,
    runCeilingUsd: ceiling,
    retentionDays: body.retentionDays,
    defaultHome: body.defaultHome,
    ai,
  };
}

type SettingsSummary = {
  enabled: boolean;
  allowedSkillsCount: number;
  monthlyBudgetUsd: string | null;
  runCeilingUsd: string | null;
  retentionDays: number | null;
  defaultHome: boolean;
  aiConfigured: boolean;
  aiProvider: string | null;
  aiModel: string | null;
};

/** Content-free (no secret fits anyway) audit summary of one settings row. */
function settingsSummary(
  row: Pick<
    StudioSettingsInput,
    | "enabled"
    | "allowedSkills"
    | "monthlyBudgetUsd"
    | "runCeilingUsd"
    | "retentionDays"
    | "defaultHome"
    | "ai"
  >,
): SettingsSummary {
  return {
    enabled: row.enabled,
    allowedSkillsCount: row.allowedSkills.length,
    monthlyBudgetUsd: row.monthlyBudgetUsd,
    runCeilingUsd: row.runCeilingUsd,
    retentionDays: row.retentionDays,
    defaultHome: row.defaultHome,
    aiConfigured: row.ai !== null,
    aiProvider: row.ai?.provider ?? null,
    aiModel: row.ai?.model ?? null,
  };
}

export type StudioSettingsAdminServiceDeps = StudioSessionDeps;

export function createStudioSettingsAdminService(
  deps: StudioSettingsAdminServiceDeps,
) {
  const environment = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const database = () => deps.getDatabase();

  return {
    /** Admin read: current row plus derived readiness flags. */
    async getWorkspaceSettings(): Promise<StudioSettingsAdminView> {
      const { settings } = await requireStudioSession(deps, "admin");
      return studioSettingsAdminView(settings, environment());
    },

    /**
     * Admin update. Validated before any write, audited with a before/after
     * summary, and read back from the database before the response is built.
     */
    async updateWorkspaceSettings(
      raw: unknown,
    ): Promise<StudioSettingsAdminView> {
      const { session, settings: before } = await requireStudioSession(
        deps,
        "admin",
      );
      const input = parseStudioSettingsUpdate(raw);
      const updated = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          await repos.studio.workspaceSettings.update(input, session.actorId);
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: session.workspaceId,
            action: "studio.settings.updated",
            metadata: {
              before: settingsSummary(before),
              after: settingsSummary(input),
            },
          });
          // Server readback: the response never echoes the request body.
          return repos.studio.workspaceSettings.get();
        },
      );
      return studioSettingsAdminView(updated, environment());
    },
  };
}

export type StudioSettingsAdminService = ReturnType<
  typeof createStudioSettingsAdminService
>;
