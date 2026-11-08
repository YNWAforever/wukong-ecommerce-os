import { describe, expect, it } from "vitest";

import { getSkill, type SkillDefinition } from "@wukong/core";

import {
  composeDeterministicReply,
  composeNeedsInputReply,
} from "./compose-deterministic.js";
import { buildEvidencePack } from "./evidence.js";
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
    expect(reply.records.checks.some((check) => check.key === "studio.check.listing_status")).toBe(
      false,
    );
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
