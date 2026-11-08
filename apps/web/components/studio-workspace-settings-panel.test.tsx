// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudioSettings } from "@wukong/db";

import {
  studioSettingsAdminView,
  type StudioSettingsAdminView,
} from "../lib/studio/settings-admin";
import { StudioWorkspaceSettingsPanel } from "./studio-workspace-settings-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Editable workspace-settings panel tests (A1): the form starts from the
 * server row, sends one validated PATCH, replaces values only from the server
 * response, and never claims success on a failed or locally invalid save.
 */

const ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  CONVERSATION_STUDIO_AI_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const BASE_ROW: StudioSettings = {
  workspaceId: "ws_test",
  enabled: true,
  allowedSkills: [],
  monthlyBudgetUsd: null,
  runCeilingUsd: null,
  retentionDays: null,
  defaultHome: false,
  ai: null,
  updatedBy: "actor_ops",
  updatedAt: new Date("2026-11-08T10:00:00.000Z"),
};

function view(
  overrides: Partial<StudioSettings> = {},
): StudioSettingsAdminView {
  return studioSettingsAdminView({ ...BASE_ROW, ...overrides }, ENV);
}

function render(initial: StudioSettingsAdminView = view()) {
  return renderToStaticMarkup(
    <StudioWorkspaceSettingsPanel locale="en" initial={initial} />,
  );
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(initial: StudioSettingsAdminView = view()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<StudioWorkspaceSettingsPanel locale="en" initial={initial} />);
  });
  return container;
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function change(container: HTMLElement, selector: string, value: string) {
  await act(async () => {
    setValue(container.querySelector(selector) as HTMLInputElement, value);
  });
}

function submit(container: HTMLElement) {
  container
    .querySelector("form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("StudioWorkspaceSettingsPanel rendering", () => {
  it("renders every editable field and the deterministic default", () => {
    const html = render();
    expect(html).toContain("Workspace settings");
    expect(html).toContain("Enable Studio");
    expect(html).toContain("Allowed skills");
    expect(html).toContain("Monthly model budget (USD)");
    expect(html).toContain("Per-run ceiling (USD)");
    expect(html).toContain("Retention days");
    expect(html).toContain("No live model (deterministic only)");
    expect(html).toContain("Save settings");
    // Model select is hidden while deterministic-only.
    expect(html).not.toContain('name="ai-provider"');
    // Pilot skills are offered and the empty selection means all.
    expect(html).toContain("catalog.find");
    expect(html).toContain(
      "No selection means every pilot skill; unknown or non-pilot skills cannot be saved.",
    );
  });

  it("prefills the AI form from a configured row", () => {
    const html = render(
      view({
        ai: {
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          pricingVersion: "studio-reviewed-v1",
          maxInputTokens: 1_048_576,
          inputUsdPerMillion: "0.3000",
          outputUsdPerMillion: "1.2000",
          maxOutputTokens: 4096,
        },
        monthlyBudgetUsd: "5.000000",
        runCeilingUsd: "1.000000",
      }),
    );
    expect(html).toContain('name="ai-provider"');
    expect(html).toContain("deepseek-v4.1-flash");
    expect(html).toContain("studio-reviewed-v1");
    expect(html).toContain("1048576");
  });
});

describe("StudioWorkspaceSettingsPanel save", () => {
  it("saves a deterministic-only configuration and renders the server readback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json(
        view({
          monthlyBudgetUsd: "5.000000",
          runCeilingUsd: "1.000000",
          retentionDays: 30,
          allowedSkills: ["catalog.find"],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await change(container, 'input[name="monthly-budget-usd"]', "5.000000");
    await change(container, 'input[name="run-ceiling-usd"]', "1.000000");
    await change(container, 'input[name="retention-days"]', "30");
    const skill = container.querySelector(
      'input[name="skill-catalog.find"]',
    ) as HTMLInputElement;
    await act(async () => {
      skill.click();
    });
    await act(async () => {
      submit(container);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("/api/studio/settings");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      enabled: true,
      allowedSkills: ["catalog.find"],
      monthlyBudgetUsd: "5.000000",
      runCeilingUsd: "1.000000",
      retentionDays: 30,
      defaultHome: false,
      ai: null,
    });
    expect(container.textContent).toContain(
      "Saved; the values below are read back from the server.",
    );
    expect(
      (
        container.querySelector(
          'input[name="monthly-budget-usd"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("5.000000");
  });

  it("sends a reviewed AI block when live analysis is enabled", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json(
        view({
          monthlyBudgetUsd: "5.000000",
          runCeilingUsd: "1.000000",
          ai: {
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            pricingVersion: "studio-reviewed-v1",
            maxInputTokens: 1_048_576,
            inputUsdPerMillion: "0.3000",
            outputUsdPerMillion: "1.2000",
            maxOutputTokens: 4096,
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await change(container, 'input[name="monthly-budget-usd"]', "5.000000");
    await change(container, 'input[name="run-ceiling-usd"]', "1.000000");
    const aiToggle = container.querySelector(
      'input[name="ai-enabled"]',
    ) as HTMLInputElement;
    await act(async () => {
      aiToggle.click();
    });
    await change(
      container,
      'input[name="ai-pricing-version"]',
      "studio-reviewed-v1",
    );
    await act(async () => {
      submit(container);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      ai: Record<string, unknown>;
    };
    expect(body.ai).toMatchObject({
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      pricingVersion: "studio-reviewed-v1",
      maxInputTokens: 1_048_576,
      inputUsdPerMillion: "0.3",
      outputUsdPerMillion: "1.2",
      maxOutputTokens: 4096,
    });
  });

  it("keeps the draft and reports an error when the server rejects the save", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(
          { code: "ai_pricing_below_bound", message: "invalid" },
          { status: 400 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await change(container, 'input[name="monthly-budget-usd"]', "7.000000");
    await act(async () => {
      submit(container);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "Settings were not saved; check the fields and try again.",
    );
    expect(container.textContent).not.toContain(
      "Saved; the values below are read back from the server.",
    );
    expect(
      (
        container.querySelector(
          'input[name="monthly-budget-usd"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("7.000000");
  });

  it("refuses a locally invalid number without calling the API", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const container = await mount();
    await change(container, 'input[name="monthly-budget-usd"]', "not-a-number");
    await act(async () => {
      submit(container);
      await Promise.resolve();
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Enter a valid number (up to 6 decimals for budgets and 4 for prices).",
    );
  });
});
