import { describe, expect, it } from "vitest";

import { getSkill, type SkillDefinition } from "@wukong/core";

import {
  composeDeterministicReply,
  composeNeedsInputReply,
} from "./compose-deterministic.js";
import { buildEvidencePack } from "./evidence.js";
import {
  createStudioTurnLimits,
  StudioTurnDeadlineError,
  StudioTurnStepBudgetError,
} from "./turn-limits.js";
import { runStudioTool, type StudioReadDeps } from "./tools.js";
import type { EvidencePack } from "./types.js";

const now = new Date("2026-11-08T10:00:00.000Z");
const LISTING_A = "listing-a";
const LISTING_B = "listing-b";

function skill(key: string): SkillDefinition {
  const definition = getSkill(key);
  if (!definition) throw new Error(`missing skill ${key}`);
  return definition;
}

const catalogFind = skill("catalog.find");
const gapReview = skill("catalog.gap_review");

function baseDeps(overrides: Partial<StudioReadDeps> = {}): StudioReadDeps {
  return {
    async searchCatalog() {
      return {
        items: [
          { listingId: LISTING_A, title: "Margaux 2019", status: "in_review" },
          { listingId: LISTING_B, title: "Rioja 2021", status: "approved" },
        ],
        truncated: false,
        unlinkedSkipped: 0,
      };
    },
    async getListing(listingId) {
      if (listingId === LISTING_A)
        return {
          listingId: LISTING_A,
          status: "in_review",
          title: "Margaux 2019",
          activeVersion: { versionId: "version-a", sequence: 2 },
          blockingFlagCount: 0,
        };
      if (listingId === LISTING_B)
        return {
          listingId: LISTING_B,
          status: "approved",
          title: "Rioja 2021",
          activeVersion: { versionId: "version-b", sequence: 1 },
          blockingFlagCount: 0,
        };
      return null;
    },
    async getQuality() {
      return {
        assessmentVersion: "opak-current-content-v1",
        totalListings: 2,
        totalAssessed: 2,
        cleanCount: 1,
        hasGapsCount: 1,
        noActiveVersion: 0,
        unassessableActiveVersion: 0,
        projectionState: "ready" as const,
        asOf: now.toISOString(),
      };
    },
    async listJobs() {
      return [
        {
          jobId: "job-1",
          state: "succeeded",
          createdAt: now.toISOString(),
        },
      ];
    },
    async getListingCopy(listingId) {
      if (listingId !== LISTING_A && listingId !== LISTING_B) return null;
      const title = listingId === LISTING_A ? "Margaux 2019" : "Rioja 2021";
      return {
        listingId,
        activeVersionId: `version-${listingId}`,
        activeVersionSequence: listingId === LISTING_A ? 2 : 1,
        title: { en: title, "zh-Hant": title },
        description: {
          en: `${title} tasting note.`,
          "zh-Hant": `${title} tasting note.`,
        },
        seo: {
          title: { en: title, "zh-Hant": title },
          description: {
            en: `${title} SEO description.`,
            "zh-Hant": `${title} SEO description.`,
          },
        },
      };
    },
    async getListingGaps(listingId) {
      if (listingId === LISTING_A)
        return {
          gaps: [
            { code: "untranslated_name", blocking: false },
            { code: "seo_title_mirrors_name", blocking: true },
          ],
        };
      return { gaps: [] };
    },
    async getSourceAssets(assetIds) {
      return {
        items: assetIds.map((assetId) => ({
          assetId,
          contentType: "image/png",
          listingId: null,
        })),
        missingAssetIds: [],
      };
    },
    async getListingRunStatus() {
      return { state: "queued" as const };
    },
    async getListingCounts() {
      return { approved: 2, in_review: 1, received: 0 };
    },
    async getExportAttempts() {
      return [
        {
          attemptId: "attempt-1",
          state: "ready" as const,
          rowCount: 2,
          createdAt: now.toISOString(),
        },
      ];
    },
    ...overrides,
  };
}

async function packFor(
  query: string | null,
  deps: StudioReadDeps,
  listingIds: readonly string[] = [],
): Promise<EvidencePack> {
  const result = await buildEvidencePack({
    skill: catalogFind,
    deps,
    role: "operator",
    now,
    query,
    listingIds,
  });
  if (result.status !== "complete")
    throw new Error(`expected a pack, got ${result.status}`);
  return result.pack;
}

describe("deterministic studio evidence and composition", () => {
  it("builds a present pack and a locale-independent deterministic reply", async () => {
    const deps = baseDeps();
    const pack = await packFor("margaux", deps);
    expect(pack.coverage.get("catalog")).toBe("present");
    expect(pack.coverage.get("listing")).toBe("present");
    expect(pack.coverage.get("quality")).toBe("present");
    expect(pack.coverage.get("job")).toBe("present");
    expect(pack.trace.map((step) => step.toolId)).toEqual([
      "catalog.search",
      "catalog.get",
      "catalog.get",
      "quality.get_gaps",
      "jobs.list",
    ]);
    expect(pack.sources.map((source) => source.kind)).toContain("listing");

    const reply = composeDeterministicReply({ skill: catalogFind, pack });
    expect(reply.status).toBe("answered");
    expect(reply.records.sections.length).toBeGreaterThan(0);
    const found = reply.records.sections.find(
      (section) => section.key === "studio.answer.catalog_found",
    );
    expect(found?.values.count).toBe(2);
    expect(reply.traceSummary.stepCount).toBe(5);

    const again = composeDeterministicReply({
      skill: catalogFind,
      pack: await packFor("margaux", baseDeps()),
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(reply));
  });

  it("treats an empty search as a counted zero and never invents listings", async () => {
    const deps = baseDeps({
      async searchCatalog() {
        return { items: [], truncated: false, unlinkedSkipped: 0 };
      },
    });
    const pack = await packFor("nothing", deps);
    expect(pack.coverage.get("catalog")).toBe("present");
    expect(pack.coverage.get("listing")).toBe("unsupported");
    expect(pack.sources.filter((source) => source.kind === "listing")).toEqual(
      [],
    );
    const reply = composeDeterministicReply({ skill: catalogFind, pack });
    expect(reply.status).toBe("answered");
    const found = reply.records.sections.find(
      (section) => section.key === "studio.answer.catalog_found",
    );
    expect(found?.values.count).toBe(0);
  });

  it("keeps a missing quality source missing and marks the reply partial", async () => {
    const deps = baseDeps({
      async getQuality() {
        throw new Error("schema unavailable");
      },
      async getListingGaps() {
        throw new Error("schema unavailable");
      },
    });
    const pack = await packFor("margaux", deps);
    expect(pack.coverage.get("quality")).toBe("missing");
    expect(
      pack.limitations.some(
        (line) => line.key === "studio.limit.quality_unavailable",
      ),
    ).toBe(true);
    const reply = composeDeterministicReply({ skill: catalogFind, pack });
    expect(reply.status).toBe("partial");
    expect(reply.records.coverage.quality).toBe("missing");
    expect(
      reply.records.sections.some(
        (section) => section.key === "studio.answer.quality_summary",
      ),
    ).toBe(false);
  });

  it("degrades honestly when the catalog tool is unavailable", async () => {
    const deps = baseDeps({
      async searchCatalog() {
        throw new Error("repository unavailable");
      },
    });
    const pack = await packFor("margaux", deps);
    expect(pack.coverage.get("catalog")).toBe("missing");
    expect(pack.trace[0]?.state).toBe("unavailable");
    expect(
      pack.limitations.some(
        (line) => line.key === "studio.limit.catalog_unavailable",
      ),
    ).toBe(true);
    const reply = composeDeterministicReply({ skill: catalogFind, pack });
    expect(reply.status).toBe("partial");
  });

  it("does not fabricate a listing when detail reads are unavailable", async () => {
    const deps = baseDeps({
      async getListing() {
        return null;
      },
    });
    const pack = await packFor("margaux", deps);
    expect(pack.coverage.get("listing")).toBe("missing");
    expect(pack.limitations.map((line) => line.key)).toContain(
      "studio.limit.listing_unavailable",
    );
    const reply = composeDeterministicReply({ skill: catalogFind, pack });
    expect(reply.status).toBe("partial");
    expect(
      reply.records.checks.some(
        (check) => check.key === "studio.check.listing_status",
      ),
    ).toBe(false);
  });

  it("reports content gaps, blocked gaps and the unread export ledger honestly", async () => {
    const result = await buildEvidencePack({
      skill: gapReview,
      deps: baseDeps(),
      role: "reviewer",
      now,
      query: null,
      listingIds: [LISTING_A],
    });
    if (result.status !== "complete") throw new Error("expected complete");
    const pack = result.pack;
    expect(pack.coverage.get("catalog")).toBe("unsupported");
    expect(pack.coverage.get("listing")).toBe("present");
    expect(pack.coverage.get("quality")).toBe("present");
    expect(pack.coverage.get("job")).toBe("present");
    expect(pack.coverage.get("export_attempt")).toBe("missing");
    expect(pack.limitations.map((line) => line.key)).toContain(
      "studio.limit.exports_not_read",
    );
    const reply = composeDeterministicReply({ skill: gapReview, pack });
    expect(reply.status).toBe("partial");
    const summary = reply.records.sections.find(
      (section) => section.key === "studio.answer.gap_review",
    );
    expect(summary?.values.contentGaps).toBe(2);
    expect(summary?.values.blockingGaps).toBe(1);
    expect(
      reply.records.checks.filter(
        (check) => check.key === "studio.check.content_gap",
      ),
    ).toHaveLength(2);
  });

  it("returns needs_input rather than searching when the required query is absent", async () => {
    let called = false;
    const result = await buildEvidencePack({
      skill: catalogFind,
      deps: baseDeps({
        async searchCatalog() {
          called = true;
          return { items: [], truncated: false, unlinkedSkipped: 0 };
        },
      }),
      role: "operator",
      now,
      query: "   ",
    });
    expect(result.status).toBe("needs_input");
    expect(called).toBe(false);
    if (result.status !== "needs_input") throw new Error("unreachable");
    const reply = composeNeedsInputReply(result);
    expect(reply.status).toBe("needs_input");
    expect(reply.followUps[0]?.key).toBe("studio.needs_input.catalog_query");
  });
});

describe("studio tool runner", () => {
  it("blocks tools the role may not execute", async () => {
    const run = await runStudioTool({
      toolId: "catalog.search",
      rawInput: { query: "x" },
      role: "viewer",
      deps: baseDeps(),
    });
    expect(run.state).toBe("blocked");
    expect(run.detail.key).toBe("studio.trace.tool.insufficient_role");
  });

  it("rejects unknown or tenant-supplied arguments without retrying", async () => {
    const unknown = await runStudioTool({
      toolId: "catalog.delete_everything",
      rawInput: {},
      role: "owner",
      deps: baseDeps(),
    });
    expect(unknown.state).toBe("blocked");
    expect(unknown.detail.key).toBe("studio.trace.tool.unknown");

    const tenantField = await runStudioTool({
      toolId: "catalog.get",
      rawInput: { listingId: LISTING_A, workspaceId: "other-workspace" },
      role: "owner",
      deps: baseDeps(),
    });
    expect(tenantField.state).toBe("blocked");
    expect(tenantField.detail.key).toBe("studio.trace.tool.invalid_arguments");
  });

  it("executes an allowed read and records a done trace detail", async () => {
    const run = await runStudioTool({
      toolId: "catalog.get",
      rawInput: { listingId: LISTING_A },
      role: "operator",
      deps: baseDeps(),
    });
    expect(run.state).toBe("done");
    expect(run.detail.key).toBe("studio.trace.tool.done");
    expect((run.output as { listingId: string }).listingId).toBe(LISTING_A);
  });
});

describe("copy-proposal evidence", () => {
  const copySkill = skill("listing.copy_proposal");

  it("records the exact listing version and current copy as the proposal target", async () => {
    const result = await buildEvidencePack({
      skill: copySkill,
      deps: baseDeps(),
      role: "operator",
      now,
      query: null,
      listingId: LISTING_A,
    });
    if (result.status !== "complete") throw new Error("expected complete");
    const pack = result.pack;
    expect(pack.coverage.get("listing")).toBe("present");
    expect(pack.coverage.get("quality")).toBe("present");
    const context = pack.context.copyProposal as {
      listingId: string;
      activeVersionId: string;
      activeVersionSequence: number;
      allowedFields: string[];
      currentCopy: { title: { en: string } };
    };
    expect(context.listingId).toBe(LISTING_A);
    expect(context.activeVersionSequence).toBe(2);
    expect(context.currentCopy.title.en).toBe("Margaux 2019");
    expect(context.allowedFields).toHaveLength(8);
    expect(
      pack.checks.filter((check) => check.key === "studio.check.copy_current"),
    ).toHaveLength(8);
    const reply = composeDeterministicReply({ skill: copySkill, pack });
    const summary = reply.records.sections.find(
      (section) => section.key === "studio.answer.copy_current",
    );
    expect(summary?.values.fields).toBe(8);
  });

  it("asks for a listing instead of searching when none is supplied", async () => {
    let catalogCalled = false;
    const result = await buildEvidencePack({
      skill: copySkill,
      deps: baseDeps({
        async getListing() {
          catalogCalled = true;
          return null;
        },
      }),
      role: "operator",
      now,
      query: null,
      listingId: null,
    });
    expect(result.status).toBe("needs_input");
    expect(catalogCalled).toBe(false);
    if (result.status !== "needs_input") throw new Error("unreachable");
    expect(result.question.key).toBe("studio.needs_input.copy_listing");
  });

  it("reports a missing current-copy snapshot honestly", async () => {
    const result = await buildEvidencePack({
      skill: copySkill,
      deps: baseDeps({
        async getListingCopy() {
          return null;
        },
      }),
      role: "operator",
      now,
      query: null,
      listingId: LISTING_A,
    });
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.pack.limitations.map((line) => line.key)).toContain(
      "studio.limit.copy_unavailable",
    );
    expect(result.pack.context.copyProposal).toBeUndefined();
  });
});

describe("studio draft-from-sources evidence (plan Task 10)", () => {
  const draftSkill = skill("listing.draft_from_sources");
  const ASSET_A = "11111111-1111-4111-8111-111111111111";
  const ASSET_B = "22222222-2222-4222-8222-222222222222";

  it("asks for at least one source asset instead of guessing", async () => {
    let read = false;
    const result = await buildEvidencePack({
      skill: draftSkill,
      deps: baseDeps({
        async getSourceAssets() {
          read = true;
          return { items: [], missingAssetIds: [] };
        },
      }),
      role: "operator",
      now,
      query: "create a draft from my uploaded files",
    });
    expect(result.status).toBe("needs_input");
    expect(read).toBe(false);
    if (result.status !== "needs_input") throw new Error("unreachable");
    expect(result.question.key).toBe("studio.needs_input.draft_assets");
  });

  it("reads attached asset ids, marks coverage present and prepares a dispatch", async () => {
    const requested: string[][] = [];
    const result = await buildEvidencePack({
      skill: draftSkill,
      deps: baseDeps({
        async getSourceAssets(assetIds) {
          requested.push([...assetIds]);
          return {
            items: assetIds.map((assetId) => ({
              assetId,
              contentType: "image/jpeg",
              listingId: null,
            })),
            missingAssetIds: [],
          };
        },
      }),
      role: "operator",
      now,
      query: "Create the draft",
      attachmentAssetIds: [ASSET_A, ASSET_B],
    });
    if (result.status !== "complete") throw new Error("expected complete");
    expect(requested[0]).toEqual([ASSET_A, ASSET_B]);
    expect(result.pack.coverage.get("source_import")).toBe("present");
    const check = result.pack.checks.find(
      (entry) => entry.key === "studio.check.draft_assets",
    );
    expect(check?.values).toMatchObject({ count: 2, missing: 0, attached: 0 });
    expect(check?.state).toBe("ok");
    expect(result.pack.context.draftDispatch).toMatchObject({
      kind: "listing_draft",
      assetIds: [ASSET_A, ASSET_B],
      note: "Create the draft",
      ready: true,
    });
    const reply = composeDeterministicReply({
      skill: draftSkill,
      pack: result.pack,
    });
    expect(reply.dispatch).toMatchObject({
      kind: "listing_draft",
      assetIds: [ASSET_A, ASSET_B],
      ready: true,
    });
    expect(reply.status).toBe("answered");
    expect(
      reply.records.sections.some(
        (section) => section.key === "studio.answer.draft_ready",
      ),
    ).toBe(true);
    // The turn never creates a listing or claims one exists.
    expect(reply.outputs).toEqual([]);
  });

  it("reads asset ids pinned in the message text when no attachments are supplied", async () => {
    const requested: string[][] = [];
    const result = await buildEvidencePack({
      skill: draftSkill,
      deps: baseDeps({
        async getSourceAssets(assetIds) {
          requested.push([...assetIds]);
          return {
            items: assetIds.map((assetId) => ({
              assetId,
              contentType: "application/pdf",
              listingId: null,
            })),
            missingAssetIds: [],
          };
        },
      }),
      role: "operator",
      now,
      query: `Please draft from asset ${ASSET_A.toUpperCase()}`,
    });
    if (result.status !== "complete") throw new Error("expected complete");
    expect(requested[0]).toEqual([ASSET_A]);
  });

  it("is partial and not ready when assets are missing or already attached", async () => {
    const result = await buildEvidencePack({
      skill: draftSkill,
      deps: baseDeps({
        async getSourceAssets(assetIds) {
          return {
            items: assetIds.map((assetId, index) => ({
              assetId,
              contentType: "image/png",
              listingId: index === 0 ? "listing-other" : null,
            })),
            missingAssetIds: ["33333333-3333-4333-8333-333333333333"],
          };
        },
      }),
      role: "operator",
      now,
      query: "Draft it",
      attachmentAssetIds: [ASSET_A, ASSET_B],
    });
    if (result.status !== "complete") throw new Error("expected complete");
    const reply = composeDeterministicReply({
      skill: draftSkill,
      pack: result.pack,
    });
    expect(reply.dispatch?.ready).toBe(false);
    expect(reply.status).toBe("partial");
    expect(result.pack.limitations.map((line) => line.key)).toContain(
      "studio.limit.draft_assets_missing",
    );
  });

  it("offers no dispatch at all when no asset resolved", async () => {
    const result = await buildEvidencePack({
      skill: draftSkill,
      deps: baseDeps({
        async getSourceAssets() {
          return {
            items: [],
            missingAssetIds: ["33333333-3333-4333-8333-333333333333"],
          };
        },
      }),
      role: "operator",
      now,
      query: "Draft it",
      attachmentAssetIds: [ASSET_A],
    });
    if (result.status !== "complete") throw new Error("expected complete");
    const reply = composeDeterministicReply({
      skill: draftSkill,
      pack: result.pack,
    });
    expect(reply.dispatch).toBeNull();
    expect(reply.status).toBe("partial");
  });
});

describe("studio merchant-audit evidence (plan Task 11)", () => {
  const auditSkill = skill("merchant.audit");

  it("composes a deterministic report payload from canonical reads", async () => {
    const result = await buildEvidencePack({
      skill: auditSkill,
      deps: baseDeps({
        async getListingCounts() {
          return { approved: 2, in_review: 1 };
        },
        async getExportAttempts() {
          return [
            {
              attemptId: "attempt-1",
              state: "ready",
              rowCount: 2,
              createdAt: now.toISOString(),
            },
            {
              attemptId: "attempt-2",
              state: "failed",
              rowCount: 0,
              createdAt: now.toISOString(),
            },
          ];
        },
      }),
      role: "operator",
      now,
      query: null,
    });
    if (result.status !== "complete") throw new Error("expected complete");
    const pack = result.pack;
    expect(pack.coverage.get("catalog")).toBe("present");
    expect(pack.coverage.get("quality")).toBe("present");
    expect(pack.coverage.get("export_attempt")).toBe("present");
    const payload = pack.context.merchantAudit as {
      schemaVersion: string;
      listings: Array<{ status: string; count: number }>;
      quality: { totalListings: number; cleanCount: number } | null;
      exports: Array<{ attemptId: string; state: string }> | null;
      checks: Array<{ key: string }>;
      limitations: Array<{ key: string }>;
    };
    expect(payload.schemaVersion).toBe("wukong-merchant-audit/v1");
    expect(payload.listings).toEqual([
      { status: "approved", count: 2 },
      { status: "in_review", count: 1 },
    ]);
    expect(payload.quality?.totalListings).toBe(2);
    expect(payload.exports?.map((row) => row.state)).toEqual([
      "ready",
      "failed",
    ]);
    expect(payload.checks.map((check) => check.key)).toEqual([
      "studio.check.audit_listing_counts",
      "studio.check.audit_quality",
      "studio.check.audit_exports",
    ]);
    expect(payload.limitations.map((line) => line.key)).toContain(
      "studio.limit.audit_period_unset",
    );

    const reply = composeDeterministicReply({ skill: auditSkill, pack });
    expect(reply.status).toBe("answered");
    expect(
      reply.records.sections.some(
        (section) => section.key === "studio.answer.audit_report",
      ),
    ).toBe(true);
    expect(reply.dispatch).toBeNull();
  });

  it("keeps an unread source null and marks the reply partial", async () => {
    const result = await buildEvidencePack({
      skill: auditSkill,
      deps: baseDeps({
        async getListingCounts() {
          throw new Error("catalog read failed");
        },
        async getExportAttempts() {
          throw new Error("export read failed");
        },
      }),
      role: "operator",
      now,
      query: null,
    });
    if (result.status !== "complete") throw new Error("expected complete");
    const payload = result.pack.context.merchantAudit as {
      listings: unknown;
      exports: unknown;
    };
    expect(payload.listings).toBeNull();
    expect(payload.exports).toBeNull();
    expect(result.pack.limitations.map((line) => line.key)).toEqual(
      expect.arrayContaining([
        "studio.limit.catalog_unavailable",
        "studio.limit.audit_exports_unavailable",
        "studio.limit.audit_period_unset",
      ]),
    );
    const reply = composeDeterministicReply({
      skill: auditSkill,
      pack: result.pack,
    });
    expect(reply.status).toBe("partial");
  });

  it("produces the same payload for the same inputs", async () => {
    const build = async () => {
      const result = await buildEvidencePack({
        skill: auditSkill,
        deps: baseDeps(),
        role: "operator",
        now,
        query: null,
      });
      if (result.status !== "complete") throw new Error("expected complete");
      return result.pack.context.merchantAudit;
    };
    expect(await build()).toEqual(await build());
  });
});
describe("turn budgets in the evidence engine", () => {
  it("aborts evidence assembly when the wall-clock deadline passes", async () => {
    let tick = 0;
    const limits = createStudioTurnLimits({
      now: () => {
        tick += 5_000;
        return tick;
      },
      deadlineMs: 2_000,
    });
    await expect(
      buildEvidencePack({
        skill: catalogFind,
        deps: baseDeps(),
        role: "operator",
        now,
        query: "margaux",
        limits,
      }),
    ).rejects.toBeInstanceOf(StudioTurnDeadlineError);
  });

  it("aborts when first-class tool steps exceed the budget", async () => {
    const limits = createStudioTurnLimits({ maxToolSteps: 1 });
    await expect(
      buildEvidencePack({
        skill: catalogFind,
        deps: baseDeps(),
        role: "operator",
        now,
        query: "margaux",
        limits,
      }),
    ).rejects.toBeInstanceOf(StudioTurnStepBudgetError);
  });
});

describe("category.map_proposal evidence (C1)", () => {
  const categoryMap = skill("category.map_proposal");

  it("asks for a listing id with the category-specific needs-input copy", async () => {
    const result = await buildEvidencePack({
      skill: categoryMap,
      deps: baseDeps(),
      role: "operator",
      now,
      query: "map the margaux",
    });
    expect(result.status).toBe("needs_input");
    if (result.status !== "needs_input")
      throw new Error("expected needs_input");
    expect(result.question.key).toBe("studio.needs_input.category_listing");
  });

  it("reads the target listing and similar catalog rows without inventing a current category", async () => {
    const result = await buildEvidencePack({
      skill: categoryMap,
      deps: baseDeps(),
      role: "operator",
      now,
      query: "map the margaux",
      listingId: LISTING_A,
    });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    const pack: EvidencePack = result.pack;
    expect(pack.coverage.get("listing")).toBe("present");
    expect(pack.coverage.get("catalog")).toBe("present");
    expect(
      pack.checks.find(
        (check) => check.key === "studio.check.category_catalog_candidates",
      )?.values,
    ).toMatchObject({ candidates: 1, truncated: false });
    expect(
      pack.checks.find((check) => check.key === "studio.check.category_current")
        ?.values,
    ).toMatchObject({ current: "unknown" });
    expect(pack.limitations.map((line) => line.key)).toContain(
      "studio.limit.category_current_unknown",
    );

    const context = pack.context.categoryMap as {
      listingId: string;
      listingTitle: string;
      currentCategory: string | null;
      catalogEvidence: Array<{ ref: string; title: string }>;
      allowedEvidenceRefs: string[];
    };
    expect(context).toMatchObject({
      listingId: LISTING_A,
      listingTitle: "Margaux 2019",
      currentCategory: null,
    });
    // The target listing is not duplicated as a "similar" candidate.
    expect(context.catalogEvidence.map((entry) => entry.ref)).toEqual([
      `catalog:${LISTING_B}`,
    ]);
    expect(context.allowedEvidenceRefs).toEqual(
      expect.arrayContaining([
        `listing:${LISTING_A}:v2`,
        `catalog:${LISTING_B}`,
      ]),
    );
    expect(
      pack.trace.some(
        (step) => step.detail.key === "studio.trace.category_evidence",
      ),
    ).toBe(true);
  });

  it("marks an unreadable listing honestly and still completes the pack", async () => {
    const result = await buildEvidencePack({
      skill: categoryMap,
      deps: baseDeps(),
      role: "operator",
      now,
      query: "map the missing listing",
      listingId: "missing-listing",
    });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.pack.coverage.get("listing")).toBe("missing");
    expect(result.pack.limitations.map((line) => line.key)).toContain(
      "studio.limit.category_listing_unavailable",
    );
    const context = result.pack.context.categoryMap as {
      listingTitle: string;
      currentCategory: string | null;
    };
    expect(context.listingTitle).toBe("");
    expect(context.currentCategory).toBeNull();
  });

  it("composes a deterministic answer section with candidates and unknown current category", async () => {
    const result = await buildEvidencePack({
      skill: categoryMap,
      deps: baseDeps(),
      role: "operator",
      now,
      query: "map the margaux",
      listingId: LISTING_A,
    });
    if (result.status !== "complete") throw new Error("expected complete");
    const reply = composeDeterministicReply({
      skill: categoryMap,
      pack: result.pack,
    });
    expect(reply.status).toBe("answered");
    const section = reply.records.sections.find(
      (line) => line.key === "studio.answer.category_map",
    );
    expect(section?.values).toMatchObject({
      candidates: 1,
      current: "unknown",
    });
    expect(reply.followUps.map((line) => line.key)).toContain(
      "studio.followup.category_review",
    );
    expect(composeNeedsInputReply).toBeTypeOf("function");
  });
});
