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

/**
 * Every key the committed service/evidence/renderer emits (plan Task 7).
 *
 * The service stores copy keys, not prose, so a missing key would reach an
 * operator as the generic fallback line instead of the real step. Pinning the
 * list here makes a rename a visible decision in the app's own test suite
 * rather than a runtime surprise.
 */
const SERVICE_KEY_PATTERN: readonly StudioCopyKey[] = [
  // task turn service
  "studio.trace.needs_input",
  "studio.trace.model.done",
  "studio.trace.model.failed",
  "studio.trace.model.budget_blocked",
  "studio.trace.model.not_admitted",
  "studio.trace.unknown",
  // deterministic composer
  "studio.answer.heading",
  "studio.answer.coverage",
  "studio.answer.catalog_found",
  "studio.answer.quality_summary",
  "studio.answer.recent_jobs",
  "studio.answer.gap_review",
  "studio.answer.workspace_quality",
  // evidence engine checks
  "studio.check.catalog_matches",
  "studio.check.listing_status",
  "studio.check.quality_summary",
  "studio.check.recent_jobs",
  "studio.check.content_gap",
  // evidence engine read limits
  "studio.limit.catalog_unavailable",
  "studio.limit.listing_unavailable",
  "studio.limit.quality_unavailable",
  "studio.limit.jobs_unavailable",
  "studio.limit.results_truncated",
  "studio.limit.exports_not_read",
  // copy-proposal skill (plan Task 9)
  "studio.limit.copy_model_required",
  "studio.limit.copy_unavailable",
  "studio.limit.copy_fields_dropped",
  "studio.answer.copy_current",
  "studio.answer.copy_proposal",
  "studio.check.copy_current",
  "studio.check.copy_gap",
  "studio.needs_input.copy_listing",
  // draft-from-sources skill (plan Task 10)
  "studio.needs_input.draft_assets",
  "studio.answer.draft_ready",
  "studio.check.draft_assets",
  "studio.limit.draft_assets_missing",
  "studio.trace.assets_read",
  "studio.trace.dispatch.done",
  "studio.followup.confirm_dispatch",
  "studio.followup.open_jobs",
  // needs input + follow-ups
  "studio.needs_input.catalog_query",
  "studio.followup.explain_status",
  "studio.followup.review_gaps",
  "studio.followup.list_attention",
  "studio.followup.open_listing",
  // tool executor trace details
  "studio.trace.tool.done",
  "studio.trace.tool.unknown",
  "studio.trace.tool.insufficient_role",
  "studio.trace.tool.invalid_arguments",
  "studio.trace.tool.unavailable",
  "studio.trace.tool.failed",
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

  it("keeps the availability labels the template cards rely on", () => {
    expect(studioCopy("en", "studio.availability.ready")).toBe("Ready");
    expect(studioCopy("en", "studio.availability.pilot")).toBe("Pilot");
    expect(studioCopy("en", "studio.availability.planned")).toBe("Planned");
    expect(studioCopy("en", "studio.availability.unavailable")).toBe(
      "Unavailable",
    );
  });

  it("contains every key the committed service emits", () => {
    for (const key of SERVICE_KEY_PATTERN) {
      expect(KEYS, key).toContain(key);
    }
  });

  it("keeps the navigation, thread, trace, evidence, output and connection keys stable", () => {
    // These are the Task 6/7 contract keys. Pinned as a list so a rename is a
    // visible decision in this test rather than a runtime undefined.
    const requiredKeys: readonly StudioCopyKey[] = [
      "studio.nav.label",
      "studio.rail.newConversation",
      "studio.rail.newConversationUnavailable",
      "studio.rail.overview",
      "studio.rail.conversations",
      "studio.rail.outputs",
      "studio.rail.tools",
      "studio.rail.settings",
      "studio.rail.settingsUnavailable",
      "studio.rail.recent",
      "studio.rail.recentEmpty",
      "studio.home.greeting",
      "studio.composer.placeholder",
      "studio.composer.empty",
      "studio.composer.working",
      "studio.composer.retry",
      "studio.composer.disclaimer",
      "studio.overview.rule",
      "studio.overview.notYetAvailable",
      "studio.trace.title",
      "studio.trace.summary",
      "studio.trace.status.done",
      "studio.trace.status.running",
      "studio.trace.status.started",
      "studio.trace.status.info",
      "studio.trace.status.unavailable",
      "studio.trace.status.blocked",
      "studio.evidence.title",
      "studio.evidence.coverage.present",
      "studio.evidence.coverage.missing",
      "studio.evidence.coverage.unsupported",
      "studio.model.title",
      "studio.model.notConfigured",
      "studio.model.failed",
      "studio.outputs.title",
      "studio.outputs.signoff",
      "studio.outputs.kind.copy_proposal",
      "studio.outputs.save",
      "studio.outputs.signOff",
      "studio.outputs.signOffRole",
      "studio.outputs.viewArtifact",
      "studio.review.title",
      "studio.review.table.field",
      "studio.review.approvalGate",
      "studio.review.noCanonicalWrite",
      "studio.review.openReview",
      "studio.signoff.signedOff",
      "studio.dispatch.title",
      "studio.dispatch.review",
      "studio.dispatch.confirm",
      "studio.dispatch.warning",
      "studio.dispatch.queueUnavailable",
      "studio.dispatch.runState.running",
      "studio.connections.title",
      "studio.connections.external",
      "studio.connections.hostedTokens",
      "studio.honest.disabled",
      "studio.honest.unknownOutcome",
      "studio.honest.quotaExhausted",
      "studio.render.fallback",
      "studio.render.yes",
      "studio.render.no",
    ];
    for (const key of requiredKeys) expect(KEYS).toContain(key);
  });

  it("declares placeholders in balanced braces with identifier names", () => {
    for (const key of KEYS) {
      for (const value of STUDIO_COPY[key]) {
        const opens = (value.match(/\{/g) ?? []).length;
        const closes = (value.match(/\}/g) ?? []).length;
        expect(opens, `${key} has unbalanced braces`).toBe(closes);
        for (const match of value.matchAll(/\{([^}]*)\}/g)) {
          expect(match[1], `${key} has a malformed placeholder`).toMatch(
            /^[a-zA-Z][a-zA-Z0-9_]*$/,
          );
        }
      }
    }
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

  it("describes read limits without turning missing evidence into zero", () => {
    expect(studioCopy("en", "studio.evidence.missingAction")).toContain(
      "Missing is not zero",
    );
    expect(studioCopy("en", "studio.limit.catalog_unavailable")).toContain(
      "no zero is substituted",
    );
    expect(studioCopy("zh-Hant", "studio.evidence.missingAction")).toContain(
      "缺少不等於零",
    );
  });
});
