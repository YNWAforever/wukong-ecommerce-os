"use client";

import { useState, type FormEvent } from "react";

import type { Locale } from "../lib/locale";
import type { StudioSettingsAdminView } from "../lib/studio/settings-admin";
import {
  studioSettingsCopy,
  type StudioSettingsCopyKey,
} from "../lib/studio-settings-copy";
import styles from "./studio.module.css";

/**
 * Editable workspace Studio settings card (A1).
 *
 * The page has already resolved the row server-side through the admin gate;
 * this panel only renders a draft and sends it to `PATCH /api/studio/settings`.
 * Nothing here reports success optimistically: the saved state, values and
 * readiness flags are replaced from the server response (which itself is a
 * database readback), and a failed save keeps the draft and says so.
 */

export type StudioWorkspaceSettingsPanelProps = {
  locale: Locale;
  initial: StudioSettingsAdminView;
};

const MONEY = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;
const PRICE = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/;
const INVALID = Symbol("invalid");

type Draft = {
  enabled: boolean;
  defaultHome: boolean;
  allowedSkills: string[];
  monthlyBudgetUsd: string;
  runCeilingUsd: string;
  retentionDays: string;
  aiEnabled: boolean;
  aiProvider: string;
  aiModel: string;
  aiPricingVersion: string;
  aiMaxInputTokens: string;
  aiInputPrice: string;
  aiOutputPrice: string;
  aiMaxOutputTokens: string;
};

function providersOf(view: StudioSettingsAdminView): string[] {
  return [
    ...new Set(view.readiness.reviewedModels.map((entry) => entry.provider)),
  ];
}

function modelsOf(view: StudioSettingsAdminView, provider: string) {
  return view.readiness.reviewedModels.filter(
    (entry) => entry.provider === provider,
  );
}

function reviewedDefaults(
  view: StudioSettingsAdminView,
  provider: string,
  model: string,
) {
  const entry = view.readiness.reviewedModels.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  );
  if (!entry) return null;
  return {
    maxInputTokens: String(entry.contextTokens),
    inputPrice: String(entry.inputUsdPerMillion),
    outputPrice: String(entry.outputUsdPerMillion),
    maxOutputTokens: "4096",
  };
}

function draftFrom(view: StudioSettingsAdminView): Draft {
  const ai = view.settings.ai;
  const providers = providersOf(view);
  const provider = ai?.provider ?? providers[0] ?? "opencode-go";
  const model = ai?.model ?? modelsOf(view, provider)[0]?.model ?? "";
  const defaults = reviewedDefaults(view, provider, model);
  return {
    enabled: view.settings.enabled,
    defaultHome: view.settings.defaultHome,
    allowedSkills: [...view.settings.allowedSkills],
    monthlyBudgetUsd: view.settings.monthlyBudgetUsd ?? "",
    runCeilingUsd: view.settings.runCeilingUsd ?? "",
    retentionDays:
      view.settings.retentionDays === null
        ? ""
        : String(view.settings.retentionDays),
    aiEnabled: ai !== null,
    aiProvider: provider,
    aiModel: model,
    aiPricingVersion: ai?.pricingVersion ?? "",
    aiMaxInputTokens:
      ai?.maxInputTokens !== null && ai !== null
        ? String(ai.maxInputTokens)
        : (defaults?.maxInputTokens ?? ""),
    aiInputPrice: ai?.inputUsdPerMillion ?? defaults?.inputPrice ?? "",
    aiOutputPrice: ai?.outputUsdPerMillion ?? defaults?.outputPrice ?? "",
    aiMaxOutputTokens:
      ai !== null
        ? String(ai.maxOutputTokens)
        : (defaults?.maxOutputTokens ?? ""),
  };
}

function optionalMoney(value: string): string | null | typeof INVALID {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return MONEY.test(trimmed) ? trimmed : INVALID;
}

function positiveInteger(value: string): number | typeof INVALID {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return INVALID;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : INVALID;
}

function buildPayload(
  draft: Draft,
): { ok: true; body: Record<string, unknown> } | { ok: false } {
  const monthly = optionalMoney(draft.monthlyBudgetUsd);
  const ceiling = optionalMoney(draft.runCeilingUsd);
  if (monthly === INVALID || ceiling === INVALID) return { ok: false };

  let retentionDays: number | null = null;
  if (draft.retentionDays.trim().length > 0) {
    const parsed = positiveInteger(draft.retentionDays);
    if (parsed === INVALID) return { ok: false };
    retentionDays = parsed;
  }

  let ai: Record<string, unknown> | null = null;
  if (draft.aiEnabled) {
    const maxInputTokens = positiveInteger(draft.aiMaxInputTokens);
    const maxOutputTokens = positiveInteger(draft.aiMaxOutputTokens);
    const inputPrice = draft.aiInputPrice.trim();
    const outputPrice = draft.aiOutputPrice.trim();
    const pricingVersion = draft.aiPricingVersion.trim();
    if (
      maxInputTokens === INVALID ||
      maxOutputTokens === INVALID ||
      !PRICE.test(inputPrice) ||
      !PRICE.test(outputPrice) ||
      pricingVersion.length === 0 ||
      draft.aiModel.length === 0
    )
      return { ok: false };
    ai = {
      provider: draft.aiProvider,
      model: draft.aiModel,
      pricingVersion,
      maxInputTokens,
      inputUsdPerMillion: inputPrice,
      outputUsdPerMillion: outputPrice,
      maxOutputTokens,
    };
  }

  return {
    ok: true,
    body: {
      enabled: draft.enabled,
      allowedSkills: draft.allowedSkills,
      monthlyBudgetUsd: monthly,
      runCeilingUsd: ceiling,
      retentionDays,
      defaultHome: draft.defaultHome,
      ai,
    },
  };
}

export function StudioWorkspaceSettingsPanel({
  locale,
  initial,
}: StudioWorkspaceSettingsPanelProps) {
  const copy = (key: StudioSettingsCopyKey) => studioSettingsCopy(locale, key);
  const [view, setView] = useState<StudioSettingsAdminView>(initial);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState<"idle" | "saved" | "invalid" | "error">(
    "idle",
  );

  const providers = providersOf(view);
  const models = modelsOf(view, draft.aiProvider);
  const readiness = view.readiness;

  function update(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setState("idle");
  }

  function selectProvider(provider: string) {
    const model = modelsOf(view, provider)[0]?.model ?? "";
    const defaults = reviewedDefaults(view, provider, model);
    update({
      aiProvider: provider,
      aiModel: model,
      ...(defaults
        ? {
            aiMaxInputTokens: defaults.maxInputTokens,
            aiInputPrice: defaults.inputPrice,
            aiOutputPrice: defaults.outputPrice,
            aiMaxOutputTokens: defaults.maxOutputTokens,
          }
        : {}),
    });
  }

  function selectModel(model: string) {
    const defaults = reviewedDefaults(view, draft.aiProvider, model);
    update({
      aiModel: model,
      ...(defaults
        ? {
            aiMaxInputTokens: defaults.maxInputTokens,
            aiInputPrice: defaults.inputPrice,
            aiOutputPrice: defaults.outputPrice,
            aiMaxOutputTokens: defaults.maxOutputTokens,
          }
        : {}),
    });
  }

  function toggleSkill(key: string, checked: boolean) {
    update({
      allowedSkills: checked
        ? [...draft.allowedSkills, key]
        : draft.allowedSkills.filter((skill) => skill !== key),
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildPayload(draft);
    if (!payload.ok) {
      setState("invalid");
      return;
    }
    setSaving(true);
    setState("idle");
    try {
      const response = await fetch("/api/studio/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.body),
      });
      if (!response.ok) {
        setState("error");
        return;
      }
      const updated = (await response.json()) as StudioSettingsAdminView;
      setView(updated);
      setDraft(draftFrom(updated));
      setState("saved");
    } catch {
      setState("error");
    } finally {
      setSaving(false);
    }
  }

  const yesNo = (value: boolean) =>
    value
      ? copy("studio.settings.workspace.on")
      : copy("studio.settings.workspace.off");
  const notSet = copy("studio.settings.workspace.notSet");

  return (
    <section
      className={styles["studio-section"]}
      aria-labelledby="studio-settings-workspace"
    >
      <header className={styles["studio-section-header"]}>
        <h2
          id="studio-settings-workspace"
          className={styles["studio-section-title"]}
        >
          {copy("studio.settings.workspace.formTitle")}
        </h2>
        <p className={styles["studio-section-lede"]}>
          {copy("studio.settings.workspace.roleNote")}
        </p>
      </header>

      <form
        className={styles["studio-settings-form"]}
        onSubmit={(event) => void save(event)}
      >
        <div className={styles["studio-settings-subsection"]}>
          <label className={styles["studio-settings-checkbox"]}>
            <input
              type="checkbox"
              name="enabled"
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            {copy("studio.settings.workspace.enableToggle")}
          </label>
          <p className={styles["studio-settings-note"]}>
            {copy("studio.settings.workspace.enableHint")}
          </p>
          <label className={styles["studio-settings-checkbox"]}>
            <input
              type="checkbox"
              name="default-home"
              checked={draft.defaultHome}
              onChange={(event) =>
                update({ defaultHome: event.target.checked })
              }
            />
            {copy("studio.settings.workspace.defaultHome")}
          </label>
          <p className={styles["studio-settings-note"]}>
            {copy("studio.settings.workspace.defaultHomeHint")}
          </p>
        </div>

        <fieldset className={styles["studio-settings-subsection"]}>
          <legend className={styles["studio-settings-subsection-title"]}>
            {copy("studio.settings.workspace.allowedSkills")}
          </legend>
          <div className={styles["studio-settings-checkboxes"]}>
            {readiness.pilotSkills.map((skill) => (
              <label
                key={skill.key}
                className={styles["studio-settings-checkbox"]}
              >
                <input
                  type="checkbox"
                  name={`skill-${skill.key}`}
                  checked={draft.allowedSkills.includes(skill.key)}
                  onChange={(event) =>
                    toggleSkill(skill.key, event.target.checked)
                  }
                />
                {skill.title[locale]} ({skill.key})
              </label>
            ))}
          </div>
          <p className={styles["studio-settings-note"]}>
            {draft.allowedSkills.length === 0
              ? `${copy("studio.settings.workspace.allSkills")}. `
              : ""}
            {copy("studio.settings.workspace.allowedSkillsHint")}
          </p>
        </fieldset>

        <div className={styles["studio-settings-subsection"]}>
          <div className={styles["studio-settings-grid"]}>
            <label className={styles["studio-settings-field"]}>
              {copy("studio.settings.workspace.budget")}
              <input
                className={styles["studio-settings-input"]}
                name="monthly-budget-usd"
                inputMode="decimal"
                value={draft.monthlyBudgetUsd}
                onChange={(event) =>
                  update({ monthlyBudgetUsd: event.target.value })
                }
              />
            </label>
            <label className={styles["studio-settings-field"]}>
              {copy("studio.settings.workspace.runCeiling")}
              <input
                className={styles["studio-settings-input"]}
                name="run-ceiling-usd"
                inputMode="decimal"
                value={draft.runCeilingUsd}
                onChange={(event) =>
                  update({ runCeilingUsd: event.target.value })
                }
              />
            </label>
            <label className={styles["studio-settings-field"]}>
              {copy("studio.settings.workspace.retention")}
              <input
                className={styles["studio-settings-input"]}
                name="retention-days"
                inputMode="numeric"
                value={draft.retentionDays}
                onChange={(event) =>
                  update({ retentionDays: event.target.value })
                }
              />
            </label>
          </div>
          <p className={styles["studio-settings-note"]}>
            {copy("studio.settings.workspace.monthlyBudgetHint")}{" "}
            {copy("studio.settings.workspace.runCeilingHint")}{" "}
            {copy("studio.settings.workspace.retentionHint")}
          </p>
        </div>

        <div className={styles["studio-settings-subsection"]}>
          <h3 className={styles["studio-settings-subsection-title"]}>
            {copy("studio.settings.workspace.aiTitle")}
          </h3>
          <p className={styles["studio-settings-note"]}>
            {copy("studio.settings.workspace.aiHint")}
          </p>
          <label className={styles["studio-settings-checkbox"]}>
            <input
              type="checkbox"
              name="ai-enabled"
              checked={draft.aiEnabled}
              onChange={(event) => update({ aiEnabled: event.target.checked })}
            />
            {copy("studio.settings.workspace.aiDeterministic")}
          </label>
          {draft.aiEnabled ? (
            <>
              <div className={styles["studio-settings-grid"]}>
                <label className={styles["studio-settings-field"]}>
                  {copy("studio.settings.workspace.aiProvider")}
                  <select
                    className={styles["studio-settings-input"]}
                    name="ai-provider"
                    value={draft.aiProvider}
                    onChange={(event) => selectProvider(event.target.value)}
                  >
                    {providers.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles["studio-settings-field"]}>
                  {copy("studio.settings.workspace.aiModel")}
                  <select
                    className={styles["studio-settings-input"]}
                    name="ai-model"
                    value={draft.aiModel}
                    onChange={(event) => selectModel(event.target.value)}
                  >
                    {models.map((entry) => (
                      <option key={entry.model} value={entry.model}>
                        {entry.model}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles["studio-settings-field"]}>
                  {copy("studio.settings.workspace.aiPricingVersion")}
                  <input
                    className={styles["studio-settings-input"]}
                    name="ai-pricing-version"
                    value={draft.aiPricingVersion}
                    onChange={(event) =>
                      update({ aiPricingVersion: event.target.value })
                    }
                  />
                </label>
                <label className={styles["studio-settings-field"]}>
                  {copy("studio.settings.workspace.aiMaxInputTokens")}
                  <input
                    className={styles["studio-settings-input"]}
                    name="ai-max-input-tokens"
                    inputMode="numeric"
                    value={draft.aiMaxInputTokens}
                    onChange={(event) =>
                      update({ aiMaxInputTokens: event.target.value })
                    }
                  />
                </label>
                <label className={styles["studio-settings-field"]}>
                  {copy("studio.settings.workspace.aiInputPrice")}
                  <input
                    className={styles["studio-settings-input"]}
                    name="ai-input-price"
                    inputMode="decimal"
                    value={draft.aiInputPrice}
                    onChange={(event) =>
                      update({ aiInputPrice: event.target.value })
                    }
                  />
                </label>
                <label className={styles["studio-settings-field"]}>
                  {copy("studio.settings.workspace.aiOutputPrice")}
                  <input
                    className={styles["studio-settings-input"]}
                    name="ai-output-price"
                    inputMode="decimal"
                    value={draft.aiOutputPrice}
                    onChange={(event) =>
                      update({ aiOutputPrice: event.target.value })
                    }
                  />
                </label>
                <label className={styles["studio-settings-field"]}>
                  {copy("studio.settings.workspace.aiMaxOutputTokens")}
                  <input
                    className={styles["studio-settings-input"]}
                    name="ai-max-output-tokens"
                    inputMode="numeric"
                    value={draft.aiMaxOutputTokens}
                    onChange={(event) =>
                      update({ aiMaxOutputTokens: event.target.value })
                    }
                  />
                </label>
              </div>
              {models.length === 0 ? (
                <p className={styles["studio-settings-note"]}>
                  {copy("studio.settings.workspace.aiNoReviewedModels")}
                </p>
              ) : null}
              <p className={styles["studio-settings-note"]}>
                {copy("studio.settings.workspace.aiReviewHint")}
              </p>
            </>
          ) : null}
        </div>

        <div className={styles["studio-settings-subsection"]}>
          <h3 className={styles["studio-settings-subsection-title"]}>
            {copy("studio.settings.workspace.readinessTitle")}
          </h3>
          <dl className={styles["studio-settings-readiness"]}>
            <div>
              <dt className={styles["studio-overview-label"]}>
                {copy("studio.settings.workspace.deploymentFlag")}
              </dt>
              <dd className={styles["studio-overview-value"]}>
                {yesNo(readiness.deploymentFlagOn)}
              </dd>
            </div>
            <div>
              <dt className={styles["studio-overview-label"]}>
                {copy("studio.settings.workspace.effectiveEnabled")}
              </dt>
              <dd className={styles["studio-overview-value"]}>
                {yesNo(readiness.studioEnabled)}
              </dd>
            </div>
            <div>
              <dt className={styles["studio-overview-label"]}>
                {copy("studio.settings.workspace.modelConfiguredLabel")}
              </dt>
              <dd className={styles["studio-overview-value"]}>
                {readiness.modelConfigured
                  ? (readiness.reviewedModels[0]?.model ?? notSet)
                  : notSet}
              </dd>
            </div>
            <div>
              <dt className={styles["studio-overview-label"]}>
                {copy("studio.settings.workspace.budgetsPresent")}
              </dt>
              <dd className={styles["studio-overview-value"]}>
                {yesNo(readiness.budgetsPresent)}
              </dd>
            </div>
          </dl>
        </div>

        <div className={styles["studio-settings-actions"]}>
          <button
            type="submit"
            className={styles["studio-secondary-button"]}
            disabled={saving}
          >
            {saving
              ? copy("studio.settings.workspace.saving")
              : copy("studio.settings.workspace.save")}
          </button>
          {state === "saved" ? (
            <p
              className={`${styles["studio-settings-state"]} ${styles["studio-settings-state-success"]}`}
              role="status"
            >
              {copy("studio.settings.workspace.saved")}
            </p>
          ) : null}
          {state === "invalid" ? (
            <p
              className={`${styles["studio-settings-state"]} ${styles["studio-settings-state-error"]}`}
              role="alert"
            >
              {copy("studio.settings.workspace.invalidNumber")}
            </p>
          ) : null}
          {state === "error" ? (
            <p
              className={`${styles["studio-settings-state"]} ${styles["studio-settings-state-error"]}`}
              role="alert"
            >
              {copy("studio.settings.workspace.saveError")}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
