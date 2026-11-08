import { describe, expect, it } from "vitest";

import {
  createStudioModel,
  FakeStudioModel,
  studioAnalysisSchema,
  studioPlanSchema,
} from "./studio-model.js";
import {
  STUDIO_NO_WRITE_RULE,
  STUDIO_UNTRUSTED_RULE,
  studioComposerMessages,
  studioPlannerMessages,
  type StudioPlannerPromptInput,
} from "./studio-prompts.js";

const skill = {
  key: "catalog.find",
  version: "1.0.0",
  title: { "zh-Hant": "尋找商品", en: "Find listings" },
  outcome: { "zh-Hant": "尋找", en: "Find" },
  limitation: { "zh-Hant": "只讀紀錄", en: "Records only" },
  inputNames: ["query"],
  allowedTools: ["catalog.search", "catalog.get"],
  requiredSources: ["catalog", "listing"],
};

const plannerInput: StudioPlannerPromptInput = {
  locale: "en",
  question: "find margaux",
  skills: [skill],
  availableTools: [
    {
      id: "catalog.search",
      description: "Search catalog",
      inputSchema: { type: "object" },
    },
  ],
  evidenceSummary: { coverage: {}, sources: [] },
};

describe("studio model prompts", () => {
  it("carry the untrusted-data and no-write rules in both prompts", () => {
    const planner = studioPlannerMessages(plannerInput);
    const composer = studioComposerMessages({
      locale: "zh-Hant",
      question: "找 Margaux",
      skill,
      evidenceSummary: { coverage: {}, sources: [], checks: [] },
      toolResults: [],
    });
    for (const messages of [planner, composer]) {
      expect(messages[0]?.role).toBe("system");
      const system = String(messages[0]?.content);
      expect(system).toContain(STUDIO_UNTRUSTED_RULE);
      expect(system).toContain(STUDIO_NO_WRITE_RULE);
      expect(system).toContain("Never invent numbers");
      const user = JSON.parse(String(messages[1]?.content)) as {
        task: string;
        locale: string;
      };
      expect(["plan", "compose"]).toContain(user.task);
      expect(["en", "zh-Hant"]).toContain(user.locale);
    }
  });
});

describe("studio plan and analysis schemas", () => {
  it("accept tools only from the allowlist and require clarification for missing inputs", () => {
    const valid = studioPlanSchema.parse({
      skillKey: "catalog.find",
      missingInputs: [],
      toolRequests: [{ toolId: "catalog.search", arguments: { query: "x" } }],
      clarification: null,
    });
    expect(valid.toolRequests).toHaveLength(1);
    expect(() =>
      studioPlanSchema.parse({ ...valid, toolRequests: [], extra: true }),
    ).toThrow();
    expect(() =>
      studioPlanSchema.parse({
        ...valid,
        toolRequests: Array.from({ length: 4 }, () => ({
          toolId: "catalog.search",
          arguments: {},
        })),
      }),
    ).toThrow();
  });

  it("requires at least one evidence ref on every claim", () => {
    const analysis = studioAnalysisSchema.parse({
      sections: [{ heading: "Summary", body: "One listing found." }],
      claims: [
        {
          text: "Margaux 2019 is in review.",
          evidenceRefs: ["listing:listing-a:v2"],
        },
      ],
      limitations: [],
      followUps: [],
      clarification: null,
    });
    expect(analysis.claims[0]?.evidenceRefs).toHaveLength(1);
    expect(() =>
      studioAnalysisSchema.parse({
        ...analysis,
        claims: [{ text: "Nothing supports this.", evidenceRefs: [] }],
      }),
    ).toThrow();
  });
});

describe("studio model adapters", () => {
  it("rejects an unreviewed provider model configuration eagerly", () => {
    expect(() =>
      createStudioModel({
        backend: "opencode-go",
        apiKey: "test-key",
        model: "not-the-reviewed-model",
        sessionId: "session-1",
      }),
    ).toThrow();
    expect(() =>
      createStudioModel({
        backend: "openrouter",
        apiKey: "test-key",
        model: "auto",
        sessionId: "session-1",
      }),
    ).toThrow();
  });

  it("scripted fake model returns validated plans and analyses deterministically", async () => {
    const fake = new FakeStudioModel({
      plans: [
        {
          skillKey: "catalog.find",
          missingInputs: [],
          toolRequests: [
            { toolId: "catalog.search", arguments: { query: "margaux" } },
          ],
          clarification: null,
        },
      ],
      analyses: [
        {
          sections: [{ heading: "Summary", body: "Grounded." }],
          claims: [
            { text: "Grounded claim", evidenceRefs: ["catalog:listing-a"] },
          ],
          limitations: [],
          followUps: [],
          clarification: null,
        },
      ],
    });
    const planned = await fake.plan(plannerInput);
    expect(planned.plan.skillKey).toBe("catalog.find");
    const composed = await fake.compose({
      locale: "en",
      question: "find margaux",
      skill,
      evidenceSummary: { coverage: {}, sources: [], checks: [] },
      toolResults: [],
    });
    expect(composed.analysis.claims[0]?.evidenceRefs).toEqual([
      "catalog:listing-a",
    ]);
    expect(composed.usage.estimatedCostUsd).toBeGreaterThan(0);
  });
});
