import { describe, expect, it } from "vitest";

import {
  STUDIO_SETTINGS_COPY,
  studioSettingsCopy,
  studioSettingsCopyParity,
  type StudioSettingsCopyKey,
} from "./studio-settings-copy.js";

/**
 * Settings-copy guard (plan Task 13): both languages present, stable keys for
 * the settings surface, and no marketing/verification claim that the registry
 * and client cannot support while external MCP stays disabled.
 */

const KEYS = Object.keys(STUDIO_SETTINGS_COPY) as StudioSettingsCopyKey[];

const BANNED_CLAIMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a guarantee", /guarantee/i],
  ["a verification claim", /\bverified\b/i],
  ["Wukong verification", /\bverified by Wukong\b/i],
  [
    "SHOPLINE acceptance",
    /\bSHOPLINE\b[^.\n]{0,20}\b(accept|accepted|accepts)\b/i,
  ],
  [
    "a named AI/vendor claim",
    /\b(openai|openrouter|opencode|anthropic|google|gemini|tavily|photoroom|typesafe|shopify|lovable)\b/i,
  ],
  ["a future AI promise", /\bAI\s+will\b/i],
  [
    "Chinese guarantee/verification claims",
    /保證|已驗證|SHOPLINE\s*接受|AI\s*會自動/,
  ],
];

describe("studio settings copy", () => {
  it("has a non-empty zh-Hant and en value for every key", () => {
    for (const key of KEYS) {
      const [zh, en] = STUDIO_SETTINGS_COPY[key];
      expect(zh.trim().length, `${key} (zh-Hant)`).toBeGreaterThan(0);
      expect(en.trim().length, `${key} (en)`).toBeGreaterThan(0);
    }
  });

  it("has unique keys namespaced `studio.settings.`", () => {
    expect(new Set(KEYS).size).toBe(KEYS.length);
    for (const key of KEYS) {
      expect(key.startsWith("studio.settings.")).toBe(true);
    }
  });

  it("reports no parity gap", () => {
    expect(studioSettingsCopyParity()).toEqual([]);
  });

  it("reads the tuple for the active locale", () => {
    expect(studioSettingsCopy("en", "studio.settings.title")).toBe(
      "Studio settings",
    );
    expect(studioSettingsCopy("zh-Hant", "studio.settings.title")).toBe(
      "工作室設定",
    );
  });

  it("keeps the keys the settings components rely on", () => {
    const required: readonly StudioSettingsCopyKey[] = [
      "studio.settings.title",
      "studio.settings.lede",
      "studio.settings.workspace.title",
      "studio.settings.workspace.budgetNote",
      "studio.settings.workspace.formTitle",
      "studio.settings.workspace.save",
      "studio.settings.workspace.saved",
      "studio.settings.workspace.saveError",
      "studio.settings.workspace.aiHint",
      "studio.settings.workspace.aiReviewHint",
      "studio.settings.tokens.title",
      "studio.settings.tokens.plaintextOnce",
      "studio.settings.tokens.scope.read",
      "studio.settings.tokens.scope.propose",
      "studio.settings.external.title",
      "studio.settings.external.disabledBanner",
      "studio.settings.external.flagOff",
      "studio.settings.external.keyMissing",
      "studio.settings.noLiveConnection",
      "studio.settings.tools.title",
    ];
    for (const key of required) expect(KEYS).toContain(key);
  });

  it("states the disabled-by-default reality in both languages", () => {
    expect(
      studioSettingsCopy("en", "studio.settings.external.disabledBanner"),
    ).toContain("disabled by default");
    expect(
      studioSettingsCopy("zh-Hant", "studio.settings.external.disabledBanner"),
    ).toContain("預設停用");
    expect(
      studioSettingsCopy("en", "studio.settings.noLiveConnection"),
    ).toContain("never");
  });

  it("makes no marketing claim in either language", () => {
    for (const key of KEYS) {
      const [zh, en] = STUDIO_SETTINGS_COPY[key];
      for (const [label, pattern] of BANNED_CLAIMS) {
        expect(
          pattern.test(zh),
          `${key} (zh-Hant) must not contain ${label}`,
        ).toBe(false);
        expect(pattern.test(en), `${key} (en) must not contain ${label}`).toBe(
          false,
        );
      }
    }
  });

  it("declares placeholders in balanced braces", () => {
    for (const key of KEYS) {
      for (const value of STUDIO_SETTINGS_COPY[key]) {
        const opens = (value.match(/\{/g) ?? []).length;
        const closes = (value.match(/\}/g) ?? []).length;
        expect(opens, `${key} has unbalanced braces`).toBe(closes);
      }
    }
  });
});
