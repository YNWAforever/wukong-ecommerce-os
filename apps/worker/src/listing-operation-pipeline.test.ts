import { describe, expect, it, vi } from "vitest";
import { emptyWorkingListing } from "@wukong/core";
import { unavailableVerification } from "./listing-verification-support.js";
import { runListingPipeline } from "./listing-pipeline.js";
import { makeHarness, draftId, workspaceId } from "./pipeline-test-support.js";

describe("immutable input pipeline", () => {
  function fixture() {
    const { deps, state } = makeHarness();
    const working = emptyWorkingListing();
    working.producer = "Saved producer";
    const run = {
      id: "00000000-0000-4000-8000-000000000901",
      listingId: draftId,
      idempotencyKey: "run",
      inputRevision: 1,
      baseVersionId: null,
      runAttempt: 1,
      activeVersionSequence: 0,
      executionState: "queued" as const,
      execution: {
        input: {
          note: "saved note",
          sources: [{ assetId: "asset_1", use: "analyse" }],
          workingContent: working,
          fieldStates: {
            producer: {
              owner: "operator",
              state: "manual",
              locked: false,
              evidenceRefs: [],
            },
          },
        },
      },
      errorCode: null,
      requestDigest: "digest",
      acceptedAt: new Date().toISOString(),
    };
    const hooks = {
      retainCandidate: vi.fn(),
      reusableExtraction: vi.fn(),
      get: vi.fn().mockResolvedValue(run),
      matches: vi.fn().mockResolvedValue(true),
      mark: vi.fn(),
    };
    const original = deps.withWorkspace;
    deps.withWorkspace = (ws, work) =>
      original(ws, (repos) => work({ ...repos, operations: hooks }));
    const input = {
      workspaceId,
      draftId,
      activeVersionSequence: 0,
      schemaVersion: 2 as const,
      runId: run.id,
      inputRevision: 1,
    };
    return { deps, state, run, hooks, input };
  }
  it("retains advisory verification for paid-provider immutable operations", async () => {
    const { deps, state, input, hooks, run } = fixture();
    hooks.get.mockResolvedValue({
      ...run,
      execution: { ...run.execution, provider: "openai" },
    });
    const verify = vi.fn(async () => unavailableVerification("network", true));
    deps.verifier = { verify };

    await expect(runListingPipeline(input, deps)).resolves.toMatchObject({
      status: "in_review",
    });

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        note: "saved note",
        listing: expect.objectContaining({ producer: "Saved producer" }),
      }),
    );
    expect(state.verificationRuns).toHaveLength(1);
    expect(state.verificationRuns[0]?.record).toMatchObject({
      listingVersionId: state.versions[0],
      outcome: "unavailable",
    });
    expect(state.aiRuns).toHaveLength(0);
    expect(state.audits).toContain("listing.verification_recorded");
  });
  it("uses persisted note and preserves an unlocked operator fact", async () => {
    const { deps, state, input } = fixture();
    const extract = vi.spyOn(deps.ai, "extract");
    const generate = vi.spyOn(deps.ai, "generate");
    await runListingPipeline(input, deps);
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({ note: "saved note" }),
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: expect.objectContaining({ producer: "Saved producer" }),
      }),
    );
    expect(generate.mock.calls[0]![0].operatorProvidedFields).toEqual([
      "producer",
    ]);
    expect(state.versions).toHaveLength(1);
  });
  it("derives trusted fact keys from locked snapshot fields, excluding copy fields", async () => {
    const { deps, run, input } = fixture();
    run.execution.input.fieldStates.producer.owner = "ai";
    run.execution.input.fieldStates.producer.locked = true;
    Object.assign(run.execution.input.fieldStates, {
      "title.en": {
        owner: "operator",
        state: "manual",
        locked: false,
        evidenceRefs: [],
      },
    });
    const generate = vi.spyOn(deps.ai, "generate");
    await runListingPipeline(input, deps);
    expect(generate.mock.calls[0]![0].operatorProvidedFields).toEqual([
      "producer",
    ]);
  });
  it("retains a late candidate and never adopts over a correction", async () => {
    const { deps, state, hooks, input } = fixture();
    const generate = deps.ai.generate.bind(deps.ai);
    deps.ai.generate = async (request) => {
      const result = await generate(request);
      hooks.matches.mockResolvedValue(false);
      return result;
    };
    await runListingPipeline(input, deps);
    expect(state.versions).toHaveLength(0);
    expect(hooks.mark).toHaveBeenCalledWith(
      input.runId,
      "superseded",
      "input_superseded",
      expect.any(Object),
    );
  });
  it("does not attach model evidence to protected operator facts", async () => {
    const { deps, input } = fixture();
    const original = deps.ai.extract.bind(deps.ai);
    deps.ai.extract = async (request) => {
      const result = await original(request);
      return {
        ...result,
        evidence: [
          ...result.evidence,
          {
            field: "producer",
            sourceAssetId: "asset_1",
            page: null,
            excerpt: "Different AI producer",
            confidence: 1,
          },
        ],
      };
    };
    const generate = vi.spyOn(deps.ai, "generate");
    await runListingPipeline(input, deps);
    expect(
      generate.mock.calls[0]![0].evidence.some((e) =>
        ["producer", "sku", "priceHkd", "stockQuantity"].includes(e.field),
      ),
    ).toBe(false);
  });
  it("does not call providers again for a terminal failed attempt", async () => {
    const { deps, input, hooks, run } = fixture();
    hooks.get.mockResolvedValue({ ...run, executionState: "failed" });
    const extract = vi.spyOn(deps.ai, "extract");
    await runListingPipeline(input, deps);
    expect(extract).not.toHaveBeenCalled();
  });
  it("does not call providers for a cancelled queued batch attempt", async () => {
    const { deps, input, hooks, run } = fixture();
    hooks.get.mockResolvedValue({ ...run, executionState: "cancelled" });
    const extract = vi.spyOn(deps.ai, "extract"),
      generate = vi.spyOn(deps.ai, "generate");
    await runListingPipeline(input, deps);
    expect(extract).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
  it("retains late batch output while cancellation prevents adoption", async () => {
    const { deps, state, hooks, input, run } = fixture();
    const generate = deps.ai.generate.bind(deps.ai);
    deps.ai.generate = async (request) => {
      const result = await generate(request);
      hooks.matches.mockResolvedValue(false);
      hooks.get.mockResolvedValue({ ...run, executionState: "cancelled" });
      return result;
    };
    await runListingPipeline(input, deps);
    expect(state.versions).toHaveLength(0);
    expect(hooks.retainCandidate).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ content: expect.any(Object) }),
    );
  });
  it("commits a selectable extraction candidate before generation can fail", async () => {
    const { deps, state, hooks, input } = fixture();
    vi.spyOn(deps.ai, "generate").mockRejectedValue(
      new Error("generation unavailable"),
    );
    await expect(runListingPipeline(input, deps)).rejects.toThrow(
      "generation unavailable",
    );
    expect(state.steps.get("extracted")?.state).toBe("completed");
    expect(hooks.retainCandidate).toHaveBeenCalledWith(
      input.runId,
      expect.objectContaining({
        stage: "extract",
        content: expect.objectContaining({ producer: expect.any(String) }),
      }),
    );
  });
  it("reuses a verified parent extraction without another extraction call", async () => {
    const { deps, state, hooks, input } = fixture();
    const checkpoint = await deps.ai.extract({
      assets: [],
      note: "saved note",
    });
    hooks.reusableExtraction.mockResolvedValue(checkpoint);
    const extract = vi.spyOn(deps.ai, "extract");
    const generate = vi.spyOn(deps.ai, "generate");
    await runListingPipeline(input, deps);
    expect(extract).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledOnce();
    expect(state.audits).toContain("listing.extraction_reused");
    expect(hooks.retainCandidate).toHaveBeenCalledWith(
      input.runId,
      expect.objectContaining({ stage: "extract" }),
    );
  });
  it("finishes needs-info without stranding a retained-version draft in processing", async () => {
    const { deps, state, hooks, input, run } = fixture();
    hooks.get.mockResolvedValue({
      ...run,
      baseVersionId: "prior-version",
      execution: {
        ...run.execution,
        input: {
          ...run.execution.input,
          workingContent: emptyWorkingListing(),
          fieldStates: {},
        },
      },
    });
    const original = deps.ai.extract.bind(deps.ai);
    deps.ai.extract = async (request) => {
      const result = await original(request);
      return {
        ...result,
        facts: {
          ...result.facts,
          producer: null,
          productType: null,
          country: null,
        },
      };
    };
    await runListingPipeline(input, deps);
    expect(state.status).toBe("needs_info");
    expect(state.versions).toHaveLength(0);
  });
});
