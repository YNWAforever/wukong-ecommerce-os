import { describe, it, expect } from "vitest";
import {
  WineEnrichmentProvider,
  WINE_EXECUTION_SNAPSHOT,
} from "./wine-enrichment-provider.js";
const cid = "00000000-0000-4000-8000-000000000001",
  eid = "00000000-0000-4000-8000-000000000002";
const request = (): any => ({
  schemaVersion: 1,
  binding: { workspaceId: "w", operationId: "o", inputRevision: 1 },
  claims: [
    {
      id: cid,
      field: "volumeMl",
      value: 750,
      kind: "fact",
      scope: "product",
      evidenceIds: [eid],
      premiseClaimIds: [],
      state: "accepted",
      reason: "trusted",
    },
  ],
  current: null,
  lockedPaths: [],
  tone: "neutral",
  claimPolicy: [],
  section: null,
});
const candidate = (): any => ({
  schemaVersion: 1,
  content: {
    title: { en: "", "zh-Hant": "" },
    seo: {
      title: { en: "", "zh-Hant": "" },
      description: { en: "", "zh-Hant": "" },
    },
    tags: [],
    sections: [
      {
        key: "introduction",
        en: "750 ml",
        "zh-Hant": "750 毫升",
        claimIds: [cid],
        locked: false,
        owner: "automatic",
      },
    ],
  },
  annotations: [
    {
      path: "sections.introduction.en",
      span: "750 ml",
      claimId: cid,
      value: 750,
      evidenceIds: [eid],
      premiseClaimIds: [],
    },
    {
      path: "sections.introduction.zh-Hant",
      span: "750 毫升",
      claimId: cid,
      value: 750,
      evidenceIds: [eid],
      premiseClaimIds: [],
    },
  ],
});
function setup(outputs: any[]) {
  const sent: any[] = [];
  const events: any[] = [];
  return {
    sent,
    events,
    provider: new WineEnrichmentProvider({
      apiKey: "test",
      sessionId: "o",
      snapshot: WINE_EXECUTION_SNAPSHOT,
      observerFactory: (c) => async (r) => {
        events.push({ ...c, ...r });
      },
      fetch: async (_u, i) => {
        sent.push(JSON.parse(String(i?.body)));
        return Response.json({
          model: "deepseek-v4.1-flash",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify(outputs.shift()),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        });
      },
    }),
  };
}
describe("wine generation and quality candidates", () => {
  it("produces an annotated candidate on pinned generation coordinates", async () => {
    const s = setup([candidate()]);
    const result = await s.provider.generate(request());
    expect(result.status).toBe("candidate");
    expect(result.requiresQualityCheck).toBe(true);
    expect(s.sent[0].model).toBe("deepseek-v4.1-flash");
    expect(s.sent[0].max_tokens).toBe(4096);
    expect(s.events[0].stage).toBe("generation");
  });
  it.each(["number", "unit", "id", "span", "scope", "coverage", "value"])(
    "rejects %s mechanically without repair",
    async (kind) => {
      const c = candidate();
      if (kind === "number")
        c.content.sections[0].en = c.annotations[0].span = "750 ml, 2018";
      if (kind === "unit")
        c.content.sections[0].en = c.annotations[0].span = "750 cl";
      if (kind === "id") c.annotations[0].claimId = eid;
      if (kind === "span") c.annotations[0].span = "other";
      if (kind === "scope") {
      }
      if (kind === "coverage") c.content.title.en = "Amazing wine";
      if (kind === "value") c.annotations[0].value = 75;
      const r = request();
      if (kind === "scope") r.claims[0].scope = "brand";
      const s = setup([c]);
      await expect(s.provider.generate(r)).rejects.toThrow();
      expect(s.sent).toHaveLength(1);
    },
  );
  it("rejects nonaccepted input before I/O", async () => {
    const r = request();
    r.claims[0].state = "unknown";
    const s = setup([]);
    await expect(s.provider.generate(r)).rejects.toThrow();
    expect(s.sent).toHaveLength(0);
  });
  it.each(["title", "seo", "tags", "locked", "operator", "section"])(
    "preserves current %s",
    async (kind) => {
      const r = request();
      r.current = candidate().content;
      if (["title", "seo", "tags"].includes(kind)) r.lockedPaths = [kind];
      const c = candidate();
      if (kind === "title") c.content.title.en = "changed";
      if (kind === "seo") c.content.seo.title.en = "changed";
      if (kind === "tags") c.content.tags = ["changed"];
      if (kind === "locked") {
        r.current.sections[0].locked = true;
      }
      if (kind === "operator") {
        r.current.sections[0].owner = "operator";
      }
      if (kind === "section") {
        r.section = "tasting";
      }
      c.content.sections[0].en = "changed";
      const s = setup([c]);
      await expect(s.provider.generate(r)).rejects.toThrow();
    },
  );
  it("checks semantics without rewriting and preserves deterministic blocking issues", async () => {
    const c = candidate();
    c.content.sections[0].en = "bad";
    const s = setup([{ schemaVersion: 1, issues: [] }]);
    const result = await s.provider.check({ request: request(), candidate: c });
    expect(result.issues.some((i) => i.blocking)).toBe(true);
    expect(result).not.toHaveProperty("content");
    expect(s.events[0].stage).toBe("quality_check");
  });
  it("rejects invented check paths or evidence", async () => {
    const s = setup([
      {
        schemaVersion: 1,
        issues: [
          { path: "price", code: "bad", blocking: true, evidenceIds: [] },
        ],
      },
    ]);
    await expect(
      s.provider.check({ request: request(), candidate: candidate() }),
    ).rejects.toThrow();
    expect(s.sent).toHaveLength(1);
  });
  it("repairs schema only once", async () => {
    const s = setup([{}, candidate()]);
    await s.provider.generate(request());
    expect(s.sent).toHaveLength(2);
  });
});

describe("additional wine writing boundaries", () => {
  it.each([
    ["abvPercent", 12, "12 years"],
    ["ageYears", 12, "12%"],
    ["vintage", 2020, "2020 ml"],
  ])("rejects wrong dimension for %s", async (field, value, span) => {
    const r = request();
    r.claims[0].field = field;
    r.claims[0].value = value;
    const c = candidate();
    c.content.sections[0].en = span;
    c.annotations[0].span = span;
    c.annotations[0].value = value;
    c.content.sections[0]["zh-Hant"] = "";
    c.annotations.pop();
    const s = setup([c]);
    await expect(s.provider.generate(r)).rejects.toThrow();
  });
  it("allows unlocked automatic metadata regeneration", async () => {
    const r = request();
    r.current = candidate().content;
    const c = candidate();
    c.content.title.en = "750 ml";
    c.annotations.push({ ...c.annotations[0], path: "title.en" });
    const s = setup([c]);
    expect((await s.provider.generate(r)).content.title.en).toBe("750 ml");
  });
  it("prevents adding text beneath a previously empty locked container", async () => {
    const r = request();
    r.current = candidate().content;
    r.lockedPaths = ["seo"];
    const c = candidate();
    c.content.seo.description.en = "750 ml";
    c.annotations.push({ ...c.annotations[0], path: "seo.description.en" });
    await expect(setup([c]).provider.generate(r)).rejects.toThrow();
  });
  it("does not accept unresolved recommendation premises", async () => {
    const r = request();
    r.claims[0] = {
      ...r.claims[0],
      kind: "recommendation",
      field: "pairing",
      premiseClaimIds: [eid],
    };
    const s = setup([]);
    await expect(s.provider.generate(r)).rejects.toThrow();
    expect(s.sent).toHaveLength(0);
  });
  it("rejects duplicate annotations references", async () => {
    const c = candidate();
    c.annotations[0].evidenceIds = [eid, eid];
    await expect(setup([c]).provider.generate(request())).rejects.toThrow();
  });
  it("cannot introduce additional locked tags", async () => {
    const r = request();
    r.current = candidate().content;
    r.current.tags = ["750 ml"];
    r.lockedPaths = ["tags"];
    const c = candidate();
    c.content.tags = ["750 ml", "750 ml"];
    c.annotations.push({ ...c.annotations[0], path: "tags.1" });
    await expect(setup([c]).provider.generate(r)).rejects.toThrow();
  });
  it("quality response rejects rewriting fields with one repair bound", async () => {
    const s = setup([
      { schemaVersion: 1, issues: [], content: {} },
      { schemaVersion: 1, issues: [], content: {} },
    ]);
    await expect(
      s.provider.check({ request: request(), candidate: candidate() }),
    ).rejects.toThrow();
    expect(s.sent).toHaveLength(2);
  });
});

describe("content completeness and ownership", () => {
  it("rejects adding a section when all sections are locked", async () => {
    const r = request();
    r.current = candidate().content;
    r.lockedPaths = ["sections"];
    const c = candidate();
    c.content.sections.push({ ...c.content.sections[0], key: "tasting" });
    c.annotations.push(
      ...c.annotations.map((a: any) => ({
        ...a,
        path: a.path.replace("introduction", "tasting"),
      })),
    );
    await expect(setup([c]).provider.generate(r)).rejects.toThrow();
  });
  it("requires both languages for changed sections", async () => {
    const c = candidate();
    c.content.sections[0]["zh-Hant"] = "";
    c.annotations.pop();
    await expect(setup([c]).provider.generate(request())).rejects.toThrow();
  });
  it("rejects commercial numerical output disguised as supported bottle volume", async () => {
    const c = candidate();
    c.content.sections[0].en = c.annotations[0].span = "Price $750";
    await expect(setup([c]).provider.generate(request())).rejects.toThrow();
  });
});

describe("natural bilingual writing", () => {
  it("accepts paraphrased bilingual candidate prose while requiring semantic review", async () => {
    const r = request();
    r.claims[0] = { ...r.claims[0], field: "tasting", value: "Plum aromas" };
    const c = candidate();
    c.content.sections[0].en = "Aromas of ripe plum invite a closer taste.";
    c.content.sections[0]["zh-Hant"] = "成熟李子的香氣，值得細味。";
    for (const a of c.annotations) {
      a.value = "Plum aromas";
      a.span = c.content.sections[0][a.path.endsWith(".en") ? "en" : "zh-Hant"];
    }
    const result = await setup([c]).provider.generate(r);
    expect(result.requiresQualityCheck).toBe(true);
    expect(result.requiresMerchantReview).toBe(true);
  });
  it("accepts explicitly labelled premise-linked recommendations", async () => {
    const r = request();
    const rec = {
      ...r.claims[0],
      id: "00000000-0000-4000-8000-000000000003",
      field: "serving",
      kind: "recommendation",
      value: "Serve cool",
      premiseClaimIds: [cid],
    };
    r.claims.push(rec);
    const c = candidate();
    c.content.sections[0].key = "serving";
    c.content.sections[0].claimIds = [rec.id];
    c.content.sections[0].en = "Recommendation: serve cool.";
    c.content.sections[0]["zh-Hant"] = "建議稍為冰鎮後飲用。";
    for (const a of c.annotations) {
      a.path = a.path.replace("introduction", "serving");
      a.claimId = rec.id;
      a.value = rec.value;
      a.premiseClaimIds = [cid];
      a.span = c.content.sections[0][a.path.endsWith(".en") ? "en" : "zh-Hant"];
    }
    expect((await setup([c]).provider.generate(r)).status).toBe("candidate");
  });
  it("preserves protected existing claims without requiring re-adoption for untouched prose", async () => {
    const r = request();
    r.current = candidate().content;
    r.current.sections[0].locked = true;
    r.current.sections[0].claimIds = [eid];
    const c = candidate();
    c.content = structuredClone(r.current);
    c.annotations = [];
    expect((await setup([c]).provider.generate(r)).content).toEqual(r.current);
  });
});

it.each(["Twelve years old.", "陳年十二年。"])(
  "withholds written numeric expressions outside supported numeric grammar: %s",
  async (text) => {
    const r = request();
    r.claims[0].field = "tasting";
    r.claims[0].value = "Plum";
    const c = candidate();
    c.content.sections[0].en = c.annotations[0].span = text;
    c.annotations[0].value = "Plum";
    c.content.sections[0]["zh-Hant"] = c.annotations[1].span = "李子";
    c.annotations[1].value = "Plum";
    await expect(setup([c]).provider.generate(r)).rejects.toThrow();
  },
);

describe("independent review regressions", () => {
  it.each(["Vintage 2018", ["Vintage 2018", "Batch 45"]])(
    "rejects partial accepted numeric string tokens %#",
    async (value) => {
      const r = request();
      r.claims[0].field = "introduction";
      r.claims[0].value = value;
      const c = candidate();
      for (const a of c.annotations) {
        a.value = value;
        a.span = "201";
      }
      c.content.sections[0].en = "201";
      c.content.sections[0]["zh-Hant"] = "201";
      const s = setup([c]);
      await expect(s.provider.generate(r)).rejects.toThrow();
      expect(s.sent).toHaveLength(1);
    },
  );
  it.each(["750 ml, 750公斤", "750 ml, 750 毫升公斤", "750 ml, 750盎司"])(
    "rejects retained unknown adjacent Chinese units %s",
    async (span) => {
      const c = candidate();
      c.content.sections[0].en = c.annotations[0].span = span;
      const s = setup([c]);
      await expect(s.provider.generate(request())).rejects.toThrow();
      expect(s.sent).toHaveLength(1);
    },
  );
  it.each([
    "sections.tasting",
    "sections.tasting.en",
    "sections.tasting.zh-Hant",
  ])("rejects introduction beneath absent lock %s", async (path) => {
    const r = request();
    r.current = candidate().content;
    r.current.sections = [];
    r.lockedPaths = [path];
    const c = candidate();
    c.content.sections[0].key = "tasting";
    c.annotations.forEach((a: any) => {
      a.path = a.path.replace("introduction", "tasting");
    });
    await expect(setup([c]).provider.generate(r)).rejects.toThrow();
  });
  it.each(["Vintage 2018", ["Vintage 2018"]])(
    "retains exact accepted numeric string token %#",
    async (value) => {
      const r = request();
      r.claims[0].field = "introduction";
      r.claims[0].value = value;
      const c = candidate();
      for (const a of c.annotations) {
        a.value = value;
        a.span = "2018";
      }
      c.content.sections[0].en = "2018";
      c.content.sections[0]["zh-Hant"] = "2018";
      expect((await setup([c]).provider.generate(r)).status).toBe("candidate");
    },
  );
  it("keeps valid metric conversions alongside Chinese volume tokens", async () => {
    const c = candidate();
    c.content.sections[0].en = c.annotations[0].span = "75 cl";
    expect((await setup([c]).provider.generate(request())).status).toBe(
      "candidate",
    );
  });
});

it("allows natural bilingual bottle-format prose after a recognized volume unit", async () => {
  const c = candidate();
  c.content.sections[0].en = c.annotations[0].span = "750 ml bottle.";
  c.content.sections[0]["zh-Hant"] = c.annotations[1].span = "750毫升瓶裝。";
  expect((await setup([c]).provider.generate(request())).status).toBe(
    "candidate",
  );
});

it.each(["750毫升瓶裝公斤", "750毫升公斤瓶裝"])(
  "does not treat an unknown or second unit as bottle prose: %s",
  async (span) => {
    const c = candidate();
    c.content.sections[0]["zh-Hant"] = c.annotations[1].span = span;
    await expect(setup([c]).provider.generate(request())).rejects.toThrow();
  },
);
