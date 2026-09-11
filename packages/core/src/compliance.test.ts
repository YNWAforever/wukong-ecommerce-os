import { describe, expect, it } from "vitest";
import {
  carryResolutions,
  localizedCopyFields,
  resolveFlag,
  scanCompliance,
} from "./compliance";

const auditContext = {
  workspaceId: "workspace-1",
  actorId: "reviewer-1",
  entityId: "listing-1",
};

type TestAuditEvent = {
  workspaceId: string;
  actorId: string;
  entityId: string;
  action: string;
  metadata: Record<string, unknown>;
};

function createAuditWriter() {
  const events: TestAuditEvent[] = [];
  return {
    events,
    writer: {
      async write(event: TestAuditEvent) {
        events.push(event);
      },
    },
  };
}

describe("scanCompliance", () => {
  it("returns deterministic blocking flags for guaranteed health benefits", () => {
    expect(
      scanCompliance({ description: "Guaranteed health benefits" }),
    ).toEqual([
      {
        id: "description:health_claim:0",
        field: "description",
        rule: "health_claim",
        severity: "blocking",
        status: "open",
        resolutionReason: null,
      },
      {
        id: "description:guarantee:1",
        field: "description",
        rule: "guarantee",
        severity: "blocking",
        status: "open",
        resolutionReason: null,
      },
    ]);
  });

  it("returns no flags when copy contains no blocking claims", () => {
    expect(scanCompliance({ title: "Estate-bottled red wine" })).toEqual([]);
  });

  it("blocks Chinese health claims and guarantees", () => {
    expect(scanCompliance({ description: "保證有保健功效" })).toEqual([
      expect.objectContaining({ rule: "health_claim", severity: "blocking" }),
      expect.objectContaining({ rule: "guarantee", severity: "blocking" }),
    ]);
  });
});

/**
 * The two rules that were declared but unreachable.
 *
 * `rating_without_evidence` and `superlative` were in the flag union and had
 * bilingual labels on the review screen, and no pattern produced either. So a
 * description could assert "Awarded 100 points by Robert Parker" against
 * `criticScores: []` and pass generation validation, pass compliance, and reach
 * approval with nothing flagged.
 */
describe("claims the listing cannot support", () => {
  const nothingGrounded = { criticScores: [], awards: [] };

  it("blocks a score the listing has no fact for", () => {
    const flags = scanCompliance(
      { descriptionEn: "Awarded 100 points by Robert Parker." },
      nothingGrounded,
    );

    expect(flags).toEqual([
      expect.objectContaining({
        rule: "rating_without_evidence",
        severity: "blocking",
        field: "descriptionEn",
      }),
    ]);
  });

  it("allows the same sentence once a grounded score exists", () => {
    // A fact only exists if extraction tied it to an evidence excerpt, so the
    // presence of one is already "something in the source said so".
    const flags = scanCompliance(
      { descriptionEn: "Awarded 100 points by Robert Parker." },
      {
        criticScores: [
          { source: "Robert Parker", score: "100", evidenceId: "ev_1" },
        ],
        awards: [],
      },
    );

    expect(flags).toEqual([]);
  });

  it("accepts an award fact as support for an award claim", () => {
    const flags = scanCompliance(
      { descriptionZhHant: "曾獲金獎。" },
      {
        criticScores: [],
        awards: [{ name: "Decanter Gold", evidenceId: "e" }],
      },
    );

    expect(flags).toEqual([]);
  });

  it.each([
    "RP 95",
    "Scored 93 pts in Wine Spectator.",
    "Gold medal at Decanter 2016.",
    "James Suckling called it remarkable.",
    "帕克評分 96 分。",
    "曾獲銀獎。",
  ])("recognises %s as a rating claim", (copy) => {
    expect(scanCompliance({ descriptionEn: copy }, nothingGrounded)).toEqual([
      expect.objectContaining({ rule: "rating_without_evidence" }),
    ]);
  });

  it("does not read an ordinary number as a score", () => {
    // Vintages, volumes and prices are everywhere in this copy. Flagging them
    // would make the rule noise and get it switched off.
    for (const copy of [
      "A 2016 vintage from a 750 ml bottle.",
      "Aged 18 months in French oak.",
      "HKD 288 per bottle.",
    ]) {
      expect(scanCompliance({ descriptionEn: copy }, nothingGrounded)).toEqual(
        [],
      );
    }
  });

  it("says nothing about ratings when the caller did not supply the facts", () => {
    // Without them an unsupported score and a grounded one are the same
    // sentence, and guessing either way is worse than staying silent.
    expect(
      scanCompliance({ descriptionEn: "Awarded 100 points by Robert Parker." }),
    ).toEqual([]);
  });
});

describe("superlatives", () => {
  it("warns rather than blocks", () => {
    // Someone has to stand behind "finest", but blocking every listing that
    // uses one would stop the pilot, and a warning still forces a human look.
    const flags = scanCompliance({ titleEn: "The finest Riesling in Mosel" });

    expect(flags).toEqual([
      expect.objectContaining({ rule: "superlative", severity: "warning" }),
    ]);
  });

  it.each([
    "The best wine of the vintage",
    "World's finest Riesling",
    "An unrivalled expression",
    "#1 in its appellation",
    "本區最佳的麗絲玲",
    "無與倫比的酒體",
  ])("recognises %s", (copy) => {
    expect(scanCompliance({ titleEn: copy })).toEqual([
      expect.objectContaining({ rule: "superlative" }),
    ]);
  });

  it("leaves an ordinary tasting note alone", () => {
    for (const copy of [
      "Perfect with grilled lamb.",
      "A restrained, mineral style.",
      "Best served at 10°C",
    ]) {
      const flags = scanCompliance({ descriptionEn: copy });
      if (copy.startsWith("Best served")) {
        // Honest limit: "best served" is a serving instruction, and this rule
        // reads it as a rank claim. A reviewer clears it; it is not silent.
        expect(flags).toHaveLength(1);
      } else {
        expect(flags).toEqual([]);
      }
    }
  });

  it("still reports a blocking flag alongside a warning", () => {
    const flags = scanCompliance(
      { descriptionEn: "Guaranteed the best health benefit" },
      { criticScores: [], awards: [] },
    );

    expect(flags.map((flag) => flag.rule).sort()).toEqual([
      "guarantee",
      "health_claim",
      "superlative",
    ]);
  });
});

describe("resolveFlag", () => {
  const flag = scanCompliance({ description: "Guaranteed quality" })[0]!;

  it("rejects a resolution reason shorter than ten meaningful characters without auditing", async () => {
    const { events, writer } = createAuditWriter();

    await expect(
      Promise.resolve().then(() =>
        resolveFlag(flag, " too short ", auditContext, writer),
      ),
    ).rejects.toThrow("A meaningful resolution reason is required");
    expect(events).toEqual([]);
  });

  it("resolves and audits a flag without mutating the original", async () => {
    const { events, writer } = createAuditWriter();

    const resolved = await resolveFlag(
      flag,
      "  Claim removed from description.  ",
      auditContext,
      writer,
    );

    expect(resolved).toEqual({
      ...flag,
      status: "resolved",
      resolutionReason: "Claim removed from description.",
    });
    expect(flag).toMatchObject({ status: "open", resolutionReason: null });
    expect(events).toEqual([
      {
        ...auditContext,
        action: "compliance.flag_resolved",
        metadata: {
          flagId: flag.id,
          field: flag.field,
          rule: flag.rule,
          resolutionReason: "Claim removed from description.",
        },
      },
    ]);
  });

  it("propagates audit writer failure without mutating the original flag", async () => {
    const writer = {
      async write() {
        throw new Error("audit unavailable");
      },
    };

    await expect(
      resolveFlag(
        flag,
        "Claim removed from description.",
        auditContext,
        writer,
      ),
    ).rejects.toThrow("audit unavailable");
    expect(flag).toMatchObject({ status: "open", resolutionReason: null });
  });
});

/**
 * Keeping an answer the operator already gave, without keeping it for ever.
 *
 * A re-scan on every save would undo every resolution, so a flag somebody had
 * answered would come back open and block approval again. Carrying every
 * resolution blindly is the opposite failure: resolve a flag, rewrite the
 * flagged sentence into something else objectionable, and the old answer stays
 * attached to text it was never about.
 */
describe("carryResolutions", () => {
  const open = {
    id: "descriptionEn:health_claim:0",
    field: "descriptionEn",
    rule: "health_claim" as const,
    severity: "blocking" as const,
    status: "open" as const,
    resolutionReason: null,
  };
  const answered = {
    ...open,
    status: "resolved" as const,
    resolutionReason: "Verified against the importer's sheet.",
  };

  it("keeps a resolution while its field is untouched", () => {
    expect(
      carryResolutions([open], [answered], new Set(["descriptionEn"])),
    ).toEqual([answered]);
  });

  it("re-opens it once that field is edited", () => {
    // The operator changed the thing that was flagged, so the justification
    // they gave for the old wording may not hold for the new wording.
    expect(carryResolutions([open], [answered], new Set())).toEqual([open]);
  });

  it("drops a flag the re-scan no longer raises", () => {
    // The claim was edited out. This is what a blind copy-forward cannot do.
    expect(
      carryResolutions([], [answered], new Set(["descriptionEn"])),
    ).toEqual([]);
  });

  it("does not resurrect a resolution for a different rule on the same field", () => {
    const other = {
      ...open,
      id: "descriptionEn:guarantee:0",
      rule: "guarantee" as const,
    };

    expect(
      carryResolutions([other], [answered], new Set(["descriptionEn"])),
    ).toEqual([other]);
  });

  it("leaves a newly raised flag open even among resolved ones", () => {
    const fresh = {
      ...open,
      id: "titleEn:health_claim:0",
      field: "titleEn",
    };

    expect(
      carryResolutions(
        [answered, fresh],
        [answered],
        new Set(["descriptionEn", "titleEn"]),
      ),
    ).toEqual([answered, fresh]);
  });
});

describe("localizedCopyFields", () => {
  it("covers every field a scan is supposed to read", () => {
    // Shared so the pipeline and the operator's save look at the same eight.
    // Two private copies is how a rule gets enforced on generated copy and not
    // on edited copy.
    const copy = { en: "en", "zh-Hant": "zh" };

    expect(
      Object.keys(
        localizedCopyFields({
          title: copy,
          description: copy,
          seo: { title: copy, description: copy },
        }),
      ).sort(),
    ).toEqual([
      "descriptionEn",
      "descriptionZhHant",
      "seoDescriptionEn",
      "seoDescriptionZhHant",
      "seoTitleEn",
      "seoTitleZhHant",
      "titleEn",
      "titleZhHant",
    ]);
  });
});
