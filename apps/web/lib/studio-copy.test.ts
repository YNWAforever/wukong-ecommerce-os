import { describe, expect, it } from "vitest";

import { localized } from "./ui-copy.js";
import {
  STUDIO_COPY,
  studioCopy,
  studioCopyParity,
  type StudioCopyKey,
} from "./studio-copy.js";

const KEYS = Object.keys(STUDIO_COPY) as StudioCopyKey[];

/**
 * Claims this copy must never make.
 *
 * `studio-copy.test.ts` scans the whole catalogue, both languages, so a later
 * edit that turns an honest limitation into a marketing promise fails here
 * instead of shipping. Note the word-boundary on `verified`: the spec's own
 * required disclaimer says "verify important numbers" and the model card is
 * labelled "unverified", and neither is a claim of verification.
 */
const BANNED_CLAIMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a guarantee", /guarantee/i],
  ["a verification claim", /\bverified\b/i],
  ["Wukong verification", /\bverified by Wukong\b/i],
  [
    "SHOPLINE acceptance",
    /\bSHOPLINE\b[^.\n]{0,20}\b(accept|accepted|accepts)\b/i,
  ],
  [
    "a named AI vendor",
    /\b(openai|openrouter|opencode|anthropic|google|gemini|tavily|photoroom|typesafe|shopify|lovable)\b/i,
  ],
  ["a future AI promise", /\bAI\s+will\b/i],
  [
    "Chinese guarantee/verification claims",
    /保證|已驗證|SHOPLINE\s*接受|AI\s*會自動/,
  ],
];

describe("STUDIO_COPY", () => {
  it("has a non-empty zh-Hant and en value for every key", () => {
    for (const key of KEYS) {
      const [zh, en] = STUDIO_COPY[key];
      expect(zh.trim().length, `${key} (zh-Hant)`).toBeGreaterThan(0);
      expect(en.trim().length, `${key} (en)`).toBeGreaterThan(0);
    }
  });

  it("has unique keys, all namespaced `studio.`", () => {
    expect(new Set(KEYS).size).toBe(KEYS.length);
    for (const key of KEYS) expect(key.startsWith("studio.")).toBe(true);
  });

  it("has no entries missing a language according to studioCopyParity", () => {
    expect(studioCopyParity()).toEqual([]);
  });

  it("reads the tuple for the active locale through localized", () => {
    expect(studioCopy("zh-Hant", "studio.rail.overview")).toBe("總覽");
    expect(studioCopy("en", "studio.rail.overview")).toBe("Overview");
    expect(studioCopy("en", "studio.rail.overview")).toBe(
      localized("en", ...STUDIO_COPY["studio.rail.overview"]),
    );
  });

  it("uses the spec's exact honest rule for the overview strip", () => {
    expect(studioCopy("en", "studio.overview.rule")).toBe(
      "From workspace records; no AI call.",
    );
    expect(studioCopy("en", "studio.composer.disclaimer")).toBe(
      "AI may be wrong; verify important numbers.",
    );
    expect(studioCopy("zh-Hant", "studio.composer.disclaimer")).toBe(
      "AI 可能會出錯；重要數字請先核對。",
    );
  });

  it("keeps the availability labels the template cards and Tasks 6/7 rely on", () => {
    expect(studioCopy("en", "studio.availability.ready")).toBe("Ready");
    expect(studioCopy("en", "studio.availability.pilot")).toBe("Pilot");
    expect(studioCopy("en", "studio.availability.planned")).toBe("Planned");
    expect(studioCopy("en", "studio.availability.unavailable")).toBe(
      "Unavailable",
    );
  });

  it("keeps the navigation, thread, trace, evidence, output and connection keys stable", () => {
    // These are the Task 6/7 contract keys. Pinned as a list so a rename is a
    // visible decision in this test rather than a runtime undefined.
    const requiredKeys: readonly StudioCopyKey[] = [
      "studio.nav.label",
      "studio.rail.newConversation",
      "studio.rail.overview",
      "studio.rail.conversations",
      "studio.rail.outputs",
      "studio.rail.tools",
      "studio.rail.settings",
      "studio.rail.recent",
      "studio.rail.recentEmpty",
      "studio.home.greeting",
      "studio.composer.placeholder",
      "studio.composer.sendingUnavailable",
      "studio.composer.disclaimer",
      "studio.overview.rule",
      "studio.overview.notYetAvailable",
      "studio.trace.title",
      "studio.trace.status.done",
      "studio.trace.status.running",
      "studio.trace.status.unavailable",
      "studio.trace.status.blocked",
      "studio.evidence.title",
      "studio.evidence.coverage.present",
      "studio.evidence.coverage.missing",
      "studio.evidence.coverage.unsupported",
      "studio.model.title",
      "studio.model.notConfigured",
      "studio.outputs.title",
      "studio.outputs.signoff",
      "studio.signoff.signedOff",
      "studio.connections.title",
      "studio.connections.external",
      "studio.honest.disabled",
      "studio.honest.unknownOutcome",
      "studio.honest.quotaExhausted",
    ];
    for (const key of requiredKeys) expect(KEYS).toContain(key);
  });
});

describe("studio copy honesty", () => {
  it("makes no marketing claim in either language", () => {
    for (const key of KEYS) {
      const [zh, en] = STUDIO_COPY[key];
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

  it("labels the model card as unverified and gives it no write authority", () => {
    expect(studioCopy("en", "studio.model.title")).toContain("unverified");
    expect(studioCopy("en", "studio.model.limitation")).toContain(
      "no write authority",
    );
  });
});
