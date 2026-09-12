/**
 * Whether the generated copy is checked against what the listing can support.
 *
 * Only the FACT EXTRACTION was ever grounded. `assertGenerationGrounding`
 * compares the 14 structured fact keys and `imageAssetIds`; title, description,
 * SEO and tags were never looked at. The only check on the prose was
 * `scanCompliance`, whose two rules covered health claims and guarantees -- so
 * a description could assert "95 points from Robert Parker" while
 * `criticScores` was empty, pass generation validation, pass compliance, and
 * reach approval with nothing flagged anywhere.
 *
 * The rule that exists to catch exactly that, `rating_without_evidence`, was
 * declared in the flag union and given bilingual labels on the review screen,
 * and nothing produced it. These cases pin the wiring: the pipeline holds the
 * facts at the call site, and has to pass them.
 */
import { describe, expect, it } from "vitest";

import { runListingPipeline } from "./listing-pipeline.js";
import {
  draftId,
  listing,
  makeHarness,
  workspaceId,
} from "./pipeline-test-support.js";

const job = { workspaceId, draftId, activeVersionSequence: 0 };

/** The fixture listing with its description, scores and awards replaced. */
function generating(
  description: string,
  claims: Partial<Pick<typeof listing, "criticScores" | "awards">> = {},
) {
  return makeHarness({
    generateProvider: async () => ({
      listing: {
        ...listing,
        ...claims,
        description: { en: description, "zh-Hant": description },
      },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        estimatedCostUsd: 0,
        latencyMs: 1,
        model: "fake",
        promptVersion: "1.0.0",
      },
    }),
  });
}

describe("a rating the listing has no fact for", () => {
  it("is flagged as blocking before anyone can approve it", async () => {
    const { deps, state } = generating(
      "Awarded 95 points by Robert Parker, and a joy with lamb.",
      { criticScores: [], awards: [] },
    );

    await runListingPipeline(job, deps);

    expect(state.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "rating_without_evidence",
          severity: "blocking",
        }),
      ]),
    );
  });

  it("is not flagged once the extraction actually found one", async () => {
    // A critic score fact exists only if extraction tied it to an evidence
    // excerpt, so its presence is already an attribution.
    const { deps, state } = generating(
      "Awarded 95 points by Robert Parker, and a joy with lamb.",
      {
        criticScores: [
          { source: "Robert Parker", score: "95", evidenceId: "ev_1" },
        ],
        awards: [],
      },
    );

    await runListingPipeline(job, deps);

    expect(
      state.flags.filter((flag) => flag.rule === "rating_without_evidence"),
    ).toEqual([]);
  });

  it("leaves ordinary copy alone", async () => {
    // The rule has to stay quiet on the common case, or it becomes noise and
    // gets switched off. Vintages and volumes are numbers too.
    const { deps, state } = generating(
      "A 2016 vintage from a 750 ml bottle, aged 18 months in oak.",
      { criticScores: [], awards: [] },
    );

    await runListingPipeline(job, deps);

    expect(state.flags).toEqual([]);
  });

  it("still reaches review, so the operator can see and answer the flag", async () => {
    // Blocking means approval refuses, not that the draft is thrown away. The
    // flag is the conversation, and the listing has to exist to have it.
    const { deps, state } = generating("Gold medal at Decanter 2016.", {
      criticScores: [],
      awards: [],
    });

    const result = await runListingPipeline(job, deps);

    expect(result.status).toBe("in_review");
    expect(state.flags).not.toEqual([]);
  });
});
