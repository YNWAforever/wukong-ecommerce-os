import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  adaptAuditFixtures,
  checkMaintenanceCandidate,
  gradeHumanVerdict,
  runOpakMaintenanceCli,
  type MaintenanceCase,
} from "./eval-opak-maintenance.js";
const fixturePath = new URL(
  "../fixtures/opak-maintenance-v1.json",
  import.meta.url,
);
const fixtures = async () => JSON.parse(await readFile(fixturePath, "utf8"));
const candidate = (item: MaintenanceCase) => ({
  workspaceId: item.workspaceId,
  listingId: item.listingId,
  inputRevision: item.inputRevision,
  sourceIds: item.sources.map((s) => s.id),
  facts: structuredClone(item.expectedFacts),
  patch: { nameZh: "合成名稱" },
  published: false,
});
describe("explicit audit fixture adapter", () => {
  it("maps all12 cases, keeps holdout and records vision/service boundaries", async () => {
    const result = adaptAuditFixtures(await fixtures());
    expect(result.cases.map((item) => item.id)).toEqual(
      Array.from(
        { length: 12 },
        (_, i) => "AI" + String(i + 1).padStart(2, "0"),
      ),
    );
    expect(
      result.cases.filter((item) => item.split === "holdout"),
    ).toHaveLength(2);
    expect(result.cases[8]?.kind).toBe("vision");
    expect(result.cases[9]?.kind).toBe("service");
    expect(result.cases[3]?.expectedFacts).toMatchObject({
      volumeMl: 750,
      abvPercent: 11.7,
    });
    expect(result.cases[5]?.expectedFacts).toMatchObject({
      packQuantity: 6,
      sku: "000056",
    });
  });
  it("rejects native evaluator format, duplicate IDs and contradictory merchant expectations", async () => {
    expect(() => adaptAuditFixtures([{ facts: { vintage: 2020 } }])).toThrow();
    const raw = await fixtures();
    raw.cases[1].id = "AI01";
    expect(() => adaptAuditFixtures(raw)).toThrow();
    const wrong = await fixtures();
    wrong.cases[5].expected_partial_facts.sku = "56";
    expect(() => adaptAuditFixtures(wrong)).toThrow();
  });
  it("does not default unknown volume, ABV or merchant facts", async () => {
    const result = adaptAuditFixtures(await fixtures());
    const unknown = result.cases[8]!;
    expect(unknown.expectedFacts).toMatchObject({
      volumeMl: null,
      abvPercent: null,
      sku: null,
      priceHkd: null,
    });
    expect(unknown.inputRevision).toBe(1);
    expect(result.cases[0]?.expectedFacts).not.toHaveProperty("packQuantity");
  });
});
describe("deterministic maintenance invariants", () => {
  it("rejects wrong numeric identity, invented claims and modified commercial fields", async () => {
    const item = adaptAuditFixtures(await fixtures()).cases[5]!,
      base = candidate(item);
    const failures = checkMaintenanceCandidate(item, {
      ...base,
      facts: {
        ...base.facts,
        volumeMl: 1500,
        packQuantity: 1,
        sku: "56",
        priceHkd: 0,
        criticScores: [{ critic: "invented", score: 99 }],
      },
    });
    expect(failures).toEqual(
      expect.arrayContaining([
        "fact_mismatch:volumeMl",
        "fact_mismatch:packQuantity",
        "commercial_changed:sku",
        "commercial_changed:priceHkd",
        "unsupported_rating",
      ]),
    );
  });
  it("preserves explicit unknowns rather than accepting bottle defaults", async () => {
    const item = adaptAuditFixtures(await fixtures()).cases[8]!,
      base = candidate(item);
    expect(
      checkMaintenanceCandidate(item, {
        ...base,
        facts: { ...base.facts, volumeMl: 750, abvPercent: 13.5 },
      }),
    ).toEqual(
      expect.arrayContaining([
        "fact_mismatch:volumeMl",
        "fact_mismatch:abvPercent",
      ]),
    );
  });
  it("enforces exactly the8 copy fields plus scope/source/revision and no publication", async () => {
    const item = adaptAuditFixtures(await fixtures()).cases[0]!,
      base = candidate(item);
    expect(
      checkMaintenanceCandidate(item, {
        ...base,
        workspaceId: "foreign",
        sourceIds: ["foreign"],
        inputRevision: 0,
        published: true,
        patch: { nameEn: "changed" },
      }),
    ).toEqual(
      expect.arrayContaining([
        "cross_workspace",
        "source_changed",
        "stale_revision",
        "unapproved_publication",
        "forbidden_copy_field",
      ]),
    );
  });
  it("accepts all eight allowed fields and rejects missing source identity and copy-only invented claims", async () => {
    const item = adaptAuditFixtures(await fixtures()).cases[0]!,
      base = candidate(item);
    const patch = {
      nameZh: "名稱",
      summaryEn: "Plain copy",
      summaryZh: "內容",
      seoTitleEn: "Title",
      seoTitleZh: "標題",
      seoDescriptionEn: "Description",
      seoDescriptionZh: "簡介",
      seoKeywords: ["synthetic"],
    };
    expect(checkMaintenanceCandidate(item, { ...base, patch })).toEqual([]);
    expect(
      checkMaintenanceCandidate(item, {
        ...base,
        sourceIds: [],
        patch: { summaryEn: "Award-winning gold medal wine rated 99 points" },
      }),
    ).toEqual(
      expect.arrayContaining([
        "source_changed",
        "unsupported_rating_copy",
        "unsupported_award_copy",
      ]),
    );
  });
  it("keeps late manual locks and old run identity separate from provider quality", async () => {
    const item = adaptAuditFixtures(await fixtures()).cases[9]!,
      base = candidate(item);
    expect(item.runInputRevision).toBeLessThan(item.inputRevision);
    expect(
      checkMaintenanceCandidate(item, {
        ...base,
        inputRevision: item.runInputRevision,
        facts: { volumeMl: 750 },
      }),
    ).toEqual(
      expect.arrayContaining([
        "stale_revision",
        "manual_lock_changed:volumeMl",
      ]),
    );
  });
  it("rejects medical copy and awards without supplied evidence", async () => {
    const item = adaptAuditFixtures(await fixtures()).cases[7]!,
      base = candidate(item);
    expect(
      checkMaintenanceCandidate(item, {
        ...base,
        facts: { ...base.facts, awards: ["invented"] },
        patch: { summaryEn: "This drink cures disease" },
      }),
    ).toEqual(expect.arrayContaining(["unsupported_award", "medical_claim"]));
  });
});
describe("human quality acceptance", () => {
  it("leaves verdict pending and never converts deterministic checks into a quality score", () => {
    expect(gradeHumanVerdict(null, [])).toEqual({
      status: "pending",
      score: null,
      hardFails: null,
    });
  });
  it("requires every human dimension and per-item90 plus zero hard failures", () => {
    const verdict = {
      reviewer: "human-reviewer",
      reviewedAt: "2026-10-01T00:00:00.000Z",
      identityFacts: 35,
      sourceGrounding: 20,
      bilingual: 15,
      businessUsability: 15,
      safety: 5,
      hardFails: 0,
    };
    expect(gradeHumanVerdict(verdict, [])).toMatchObject({
      status: "passed",
      score: 90,
    });
    expect(gradeHumanVerdict({ ...verdict, safety: 4 }, [])).toMatchObject({
      status: "failed",
      score: 89,
    });
    expect(gradeHumanVerdict(verdict, ["fact_mismatch:vintage"])).toMatchObject(
      { status: "failed" },
    );
    expect(() =>
      gradeHumanVerdict({ ...verdict, identityFacts: 36 }, []),
    ).toThrow();
  });
});
describe("CLI admission, privacy and cost certainty", () => {
  it("dry maps12 with zero provider construction/calls and no qualityscore/content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opak-eval-"));
    const factory = vi.fn();
    try {
      const report = await runOpakMaintenanceCli(
        ["--dry-run", "--output", join(directory, "report.json")],
        {},
        { providerFactory: factory },
      );
      expect(factory).not.toHaveBeenCalled();
      expect(report.providerRequests).toBe(0);
      expect(report.qualityStatus).toBe("not_evaluated");
      expect(JSON.stringify(report)).not.toContain("Synthetic cellar");
      expect(JSON.stringify(report)).not.toContain("expected_partial_facts");
      expect(report.deterministicHarnessChecks.status).toBe("passed");
      expect(report.deterministicHarnessChecks.checks).toBeGreaterThan(72);
      const raw = await fixtures();
      for (const item of raw.cases)
        for (const value of Object.values(item.inputs))
          if (typeof value === "string")
            expect(JSON.stringify(report)).not.toContain(value);
      expect(report.items).toHaveLength(12);
      expect(report.items.every((item) => item.humanVerdict === null)).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("live requires positive budget, authorization and configured provider before construction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opak-eval-"));
    const factory = vi.fn();
    try {
      for (const args of [
        ["--mode=live", "--budget-usd", "0"],
        ["--mode=live", "--budget-usd", "1"],
      ]) {
        const report = await runOpakMaintenanceCli(
          [...args, "--output", join(directory, crypto.randomUUID() + ".json")],
          {},
          { providerFactory: factory },
        );
        expect(report.status).toBe("blocked");
        expect(report.providerRequests).toBe(0);
      }
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("blocks a tracked repository output path and dry private-content opt-in", async () => {
    const factory = vi.fn();
    await expect(
      runOpakMaintenanceCli(
        [
          "--dry-run",
          "--output",
          fileURLToPath(
            new URL("../fixtures/private-evidence.json", import.meta.url),
          ),
        ],
        {},
        { providerFactory: factory },
      ),
    ).rejects.toThrow();
    const directory = await mkdtemp(join(tmpdir(), "opak-eval-"));
    try {
      await expect(
        runOpakMaintenanceCli(
          [
            "--dry-run",
            "--include-private-content",
            "--output",
            join(directory, "report.json"),
          ],
          {},
          { providerFactory: factory },
        ),
      ).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("refuses overwriting evidence before any paid provider construction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opak-eval-")),
      path = join(directory, "exists.json"),
      factory = vi.fn();
    try {
      await writeFile(path, "kept");
      await expect(
        runOpakMaintenanceCli(
          ["--mode=live", "--budget-usd", "1", "--output", path],
          {},
          { providerFactory: factory },
        ),
      ).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe("kept");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("stops after unknown-cost attempt and never labels it zero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opak-eval-"));
    let calls = 0;
    const factory = vi.fn(() => ({
      evaluate: async (item: MaintenanceCase) => {
        calls++;
        return {
          candidate: candidate(item),
          providerRequests: 1,
          model: "synthetic-2026-01-01",
          promptVersions: ["synthetic-v1"],
          latencyMs: 10,
          costUsd: null,
          costCertainty: "unknown" as const,
        };
      },
    }));
    try {
      const report = await runOpakMaintenanceCli(
        [
          "--mode=live",
          "--budget-usd",
          "1",
          "--confirm-authorized-data",
          "--output",
          join(directory, "report.json"),
        ],
        {
          OPAK_EVAL_LIVE_AUTHORIZED: "1",
          OPAK_EVAL_PROVIDER: "openai",
          OPENAI_API_KEY: "synthetic-not-a-real-key",
          OPAK_EVAL_MODEL: "synthetic-2026-01-01",
          OPAK_EVAL_PRICING_VERSION: "synthetic-v1",
          OPAK_EVAL_INPUT_USD_PER_MILLION: "1",
          OPAK_EVAL_OUTPUT_USD_PER_MILLION: "1",
          OPAK_EVAL_MAX_INPUT_TOKENS: "10000",
        },
        { providerFactory: factory },
      );
      expect(calls).toBe(1);
      expect(report.stopReason).toBe("unknown_cost");
      expect(report.items[0]?.cost).toMatchObject({
        certainty: "unknown",
        usd: null,
      });
      expect(report.qualityStatus).toBe("human_review_required");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
