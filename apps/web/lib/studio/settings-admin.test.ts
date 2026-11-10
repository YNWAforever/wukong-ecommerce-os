import { describe, expect, it } from "vitest";

import { getSkill, studioTurnReservation } from "@wukong/core";
import type { StudioSettings } from "@wukong/db";

import { isStudioEnabled } from "../studio-flags";
import type { FakeStudioOptions } from "./test-fakes";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
} from "./test-fakes";
import {
  createStudioSettingsAdminService,
  parseStudioSettingsUpdate,
  REVIEWED_STUDIO_MODELS,
  STUDIO_MONTHLY_BUDGET_MAX_USD,
  studioSettingsAdminView,
  updateStudioSettingsBodySchema,
  type StudioSettingsAdminServiceDeps,
} from "./settings-admin.js";

/**
 * Workspace settings administration tests (A1).
 *
 * Fakes only: the fake workspace repo records the update and the audit row, and
 * the service's validation runs against the real reviewed cost registry
 * (`studioTurnReservation`), so a placeholder model or under-bound price must
 * fail here exactly as it would at the first live turn.
 */

const WORKSPACE = "ws_test";
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  CONVERSATION_STUDIO_AI_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const BASE_BODY = {
  enabled: true,
  allowedSkills: ["catalog.find"],
  monthlyBudgetUsd: "5.000000",
  runCeilingUsd: "1.000000",
  retentionDays: 30,
  defaultHome: true,
  ai: null,
};

const AI_BLOCK = {
  provider: "opencode-go" as const,
  model: "deepseek-v4.1-flash",
  pricingVersion: "studio-reviewed-v1",
  maxInputTokens: 1_048_576,
  inputUsdPerMillion: "0.3000",
  outputUsdPerMillion: "1.2000",
  maxOutputTokens: 4096,
};

function fixture(
  input: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    options?: FakeStudioOptions;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const options = input.options ?? {};
  const fake = createFakeStudio({
    ...options,
    settings: {
      workspaceId: WORKSPACE,
      enabled: true,
      ...(options.settings ?? {}),
    } satisfies Partial<StudioSettings>,
  });
  const session = fakeSessionContext(input.role ?? "admin", {
    workspaceId: WORKSPACE,
  });
  const deps: StudioSettingsAdminServiceDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    isStudioEnabled,
    env: input.env ?? ON_ENV,
  };
  return { service: createStudioSettingsAdminService(deps), fake };
}

describe("reviewed Studio model mirror", () => {
  it("only lists pairs the reviewed admission accepts", () => {
    expect(REVIEWED_STUDIO_MODELS.length).toBeGreaterThan(0);
    for (const entry of REVIEWED_STUDIO_MODELS) {
      expect(() =>
        studioTurnReservation({
          provider: entry.provider,
          model: entry.model,
          pricingVersion: "mirror-test",
          runCeilingUsd: "1.000000",
          budgetCapUsd: "5.000000",
          maxInputTokens: entry.contextTokens,
          inputUsdPerMillion: entry.inputUsdPerMillion,
          outputUsdPerMillion: entry.outputUsdPerMillion,
          maxOutputTokens: 4096,
        }),
      ).not.toThrow();
    }
  });

  it("rejects a pair the reviewed registry does not know, and under-bound pricing", () => {
    expect(() =>
      studioTurnReservation({
        provider: "openrouter",
        model: "deepseek-v4.1-flash",
        pricingVersion: "mirror-test",
        runCeilingUsd: "1.000000",
        budgetCapUsd: "5.000000",
        maxInputTokens: 1_048_576,
        inputUsdPerMillion: 0.3,
        outputUsdPerMillion: 1.2,
        maxOutputTokens: 4096,
      }),
    ).toThrow("unverified_model_budget_bound");
    expect(() =>
      studioTurnReservation({
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        pricingVersion: "mirror-test",
        runCeilingUsd: "1.000000",
        budgetCapUsd: "5.000000",
        maxInputTokens: 1_048_576,
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 1.2,
        maxOutputTokens: 4096,
      }),
    ).toThrow("unverified_model_budget_bound");
  });
});

describe("settings admin read", () => {
  it("returns the current row plus honest readiness flags", async () => {
    const { service } = fixture();
    const view = await service.getWorkspaceSettings();
    expect(view.settings).toMatchObject({
      enabled: true,
      allowedSkills: [],
      monthlyBudgetUsd: null,
      runCeilingUsd: null,
      retentionDays: null,
      defaultHome: false,
      ai: null,
    });
    expect(view.readiness).toMatchObject({
      deploymentFlagOn: true,
      aiFlagOn: true,
      workspaceEnabled: true,
      studioEnabled: true,
      modelConfigured: false,
      budgetsPresent: false,
    });
    expect(view.readiness.reviewedModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
        }),
      ]),
    );
    const pilotKeys = view.readiness.pilotSkills.map((skill) => skill.key);
    expect(pilotKeys).toContain("catalog.find");
    expect(pilotKeys.every((key) => getSkill(key)?.status === "pilot")).toBe(
      true,
    );
    expect(view.readiness.limits).toMatchObject({
      monthlyBudgetMaxUsd: STUDIO_MONTHLY_BUDGET_MAX_USD,
      retentionDaysMax: 365,
      maxOutputTokens: 16_384,
    });
  });

  it("requires admin and an enabled Studio", async () => {
    for (const role of ["viewer", "operator", "reviewer"] as const) {
      const { service } = fixture({ role });
      await expect(service.getWorkspaceSettings()).rejects.toMatchObject({
        status: 403,
        code: "insufficient_role",
      });
      await expect(
        service.updateWorkspaceSettings(BASE_BODY),
      ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
    }

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    await expect(disabled.service.getWorkspaceSettings()).rejects.toMatchObject(
      { status: 404, code: "not_found" },
    );

    const workspaceOff = fixture({
      options: { settings: { enabled: false } },
    });
    await expect(
      workspaceOff.service.getWorkspaceSettings(),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("settings admin update", () => {
  it("persists a deterministic-only configuration, audits it and reads back", async () => {
    const { service, fake } = fixture();
    const result = await service.updateWorkspaceSettings(BASE_BODY);

    expect(fake.state.settings).toMatchObject({
      enabled: true,
      allowedSkills: ["catalog.find"],
      monthlyBudgetUsd: "5.000000",
      runCeilingUsd: "1.000000",
      retentionDays: 30,
      defaultHome: true,
      ai: null,
      updatedBy: "actor_ops",
    });
    expect(result.settings).toMatchObject({
      enabled: true,
      allowedSkills: ["catalog.find"],
      monthlyBudgetUsd: "5.000000",
      runCeilingUsd: "1.000000",
      retentionDays: 30,
      defaultHome: true,
      ai: null,
      updatedBy: "actor_ops",
    });
    expect(result.readiness).toMatchObject({
      modelConfigured: false,
      budgetsPresent: true,
      workspaceEnabled: true,
    });

    const audit = fake.state.audits.find(
      (event) => event.action === "studio.settings.updated",
    );
    expect(audit).toBeDefined();
    expect(audit?.metadata).toMatchObject({
      before: { enabled: true, aiConfigured: false },
      after: {
        enabled: true,
        allowedSkillsCount: 1,
        monthlyBudgetUsd: "5.000000",
        runCeilingUsd: "1.000000",
        retentionDays: 30,
        defaultHome: true,
        aiConfigured: false,
      },
    });
    expect(fake.state.writes).toContain("workspaceSettings.update");
  });

  it("accepts a reviewed AI block and reports it configured", async () => {
    const { service, fake } = fixture();
    const result = await service.updateWorkspaceSettings({
      ...BASE_BODY,
      ai: AI_BLOCK,
    });
    expect(result.settings.ai).toEqual(AI_BLOCK);
    expect(result.readiness).toMatchObject({
      modelConfigured: true,
      budgetsPresent: true,
    });
    expect(fake.state.settings.ai).toEqual(AI_BLOCK);

    const audit = fake.state.audits.find(
      (event) => event.action === "studio.settings.updated",
    );
    expect(audit?.metadata).toMatchObject({
      before: { aiConfigured: false },
      after: {
        aiConfigured: true,
        aiProvider: "opencode-go",
        aiModel: "deepseek-v4.1-flash",
      },
    });
  });

  it("can turn live AI back off without losing the deterministic settings", async () => {
    const { service, fake } = fixture({
      options: { settings: { ai: AI_BLOCK } },
    });
    const result = await service.updateWorkspaceSettings({
      ...BASE_BODY,
      ai: null,
    });
    expect(result.settings.ai).toBeNull();
    expect(result.settings.monthlyBudgetUsd).toBe("5.000000");
    const audit = fake.state.audits.find(
      (event) => event.action === "studio.settings.updated",
    );
    expect(audit?.metadata).toMatchObject({
      before: { aiConfigured: true },
      after: { aiConfigured: false },
    });
    expect(fake.state.settings.ai).toBeNull();
  });

  it("normalizes duplicate allowed skills to one entry", async () => {
    const { service } = fixture();
    const result = await service.updateWorkspaceSettings({
      ...BASE_BODY,
      allowedSkills: ["catalog.find", "catalog.find"],
    });
    expect(result.settings.allowedSkills).toEqual(["catalog.find"]);
  });

  it("rejects each invalid shape without writing or auditing", async () => {
    const { service, fake } = fixture();
    const cases: Array<[unknown, string]> = [
      [{ ...BASE_BODY, extra: true }, "invalid_settings"],
      [{ ...BASE_BODY, enabled: "yes" }, "invalid_settings"],
      [{ ...BASE_BODY, allowedSkills: ["nope.unknown"] }, "unknown_skill"],
      [
        { ...BASE_BODY, allowedSkills: ["customer.reply_draft"] },
        "unknown_skill",
      ],
      [
        {
          ...BASE_BODY,
          monthlyBudgetUsd: `${STUDIO_MONTHLY_BUDGET_MAX_USD + 1}.000000`,
        },
        "invalid_budget",
      ],
      [
        {
          ...BASE_BODY,
          monthlyBudgetUsd: "1.000000",
          runCeilingUsd: "2.000000",
        },
        "invalid_budget",
      ],
      [
        { ...BASE_BODY, monthlyBudgetUsd: null, runCeilingUsd: "1.000000" },
        "invalid_budget",
      ],
      [{ ...BASE_BODY, retentionDays: 0 }, "invalid_settings"],
      [{ ...BASE_BODY, retentionDays: 366 }, "invalid_settings"],
      [
        { ...BASE_BODY, ai: { ...AI_BLOCK, pricingVersion: "" } },
        "invalid_settings",
      ],
      [
        { ...BASE_BODY, ai: { ...AI_BLOCK, model: "not-a-model" } },
        "ai_not_reviewed",
      ],
      [
        {
          ...BASE_BODY,
          ai: {
            ...AI_BLOCK,
            provider: "openrouter",
          },
        },
        "ai_not_reviewed",
      ],
      [
        {
          ...BASE_BODY,
          ai: { ...AI_BLOCK, maxInputTokens: AI_BLOCK.maxInputTokens + 1 },
        },
        "ai_tokens_above_model_context",
      ],
      [
        {
          ...BASE_BODY,
          ai: { ...AI_BLOCK, inputUsdPerMillion: "0.1000" },
        },
        "ai_pricing_below_bound",
      ],
      [
        {
          ...BASE_BODY,
          monthlyBudgetUsd: null,
          runCeilingUsd: null,
          ai: AI_BLOCK,
        },
        "ai_budget_missing",
      ],
      [
        {
          ...BASE_BODY,
          monthlyBudgetUsd: "5.000000",
          runCeilingUsd: "0.000001",
          ai: AI_BLOCK,
        },
        "ai_run_ceiling_too_small",
      ],
    ];
    for (const [body, code] of cases) {
      await expect(
        service.updateWorkspaceSettings(body),
        JSON.stringify(body),
      ).rejects.toMatchObject({ status: 400, code });
    }
    expect(fake.state.audits).toEqual([]);
    expect(fake.state.writes).not.toContain("workspaceSettings.update");
  });
});

describe("settings admin pure helpers", () => {
  it("exposes a strict request schema that rejects unknown keys", () => {
    expect(updateStudioSettingsBodySchema.safeParse(BASE_BODY).success).toBe(
      true,
    );
    expect(
      updateStudioSettingsBodySchema.safeParse({ ...BASE_BODY, extra: 1 })
        .success,
    ).toBe(false);
    expect(
      updateStudioSettingsBodySchema.safeParse({
        ...BASE_BODY,
        retentionDays: 1,
        ai: AI_BLOCK,
      }).success,
    ).toBe(true);
  });

  it("maps a valid body to the repository input shape", () => {
    const input = parseStudioSettingsUpdate({
      ...BASE_BODY,
      ai: AI_BLOCK,
    });
    expect(input.ai).toEqual(AI_BLOCK);
    expect(input.allowedSkills).toEqual(["catalog.find"]);
  });

  it("builds an honest view without inventing an AI configuration", () => {
    const settings: StudioSettings = {
      workspaceId: WORKSPACE,
      enabled: true,
      allowedSkills: [],
      monthlyBudgetUsd: null,
      runCeilingUsd: null,
      retentionDays: null,
      defaultHome: false,
      ai: null,
      updatedBy: "actor_ops",
      updatedAt: new Date("2026-11-09T00:00:00.000Z"),
    };
    const view = studioSettingsAdminView(settings, {
      CONVERSATION_STUDIO_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv);
    expect(view.settings.updatedAt).toBe("2026-11-09T00:00:00.000Z");
    expect(view.readiness).toMatchObject({
      deploymentFlagOn: true,
      aiFlagOn: false,
      modelConfigured: false,
      budgetsPresent: false,
    });
  });
});
