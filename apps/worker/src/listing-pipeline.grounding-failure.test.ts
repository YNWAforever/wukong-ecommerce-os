/**
 * What a grounding rejection costs the operator.
 *
 * `assertFactsGrounded` raises `ProviderOutputError` for a fact the model
 * normalized or classified correctly but cannot quote verbatim off a label --
 * see `packages/ai/src/listing-output-validation.grounding.test.ts`. This file
 * carries that error the rest of the way through the pipeline.
 *
 * `ProviderOutputError` is in `isTerminalProviderError`, so unlike a timeout it
 * is terminal on the FIRST delivery: one call, straight to `failed`, and the
 * consumer acks so nothing is retried or dead-lettered.
 *
 * Already covered elsewhere, and deliberately not repeated here: safe error
 * redaction (`listing-consumer.test.ts`) and transient-timeout retry budgeting
 * (`listing-pipeline.recovery.test.ts`). What is pinned below is what the
 * operator is actually left holding -- no version, no completed run, and no
 * telemetry explaining why.
 *
 * Phase 0 reproduction of F02 / F03 / F04. Phase 1 inverts these assertions.
 */
import { describe, expect, it, vi } from "vitest";

import { ProviderOutputError } from "@wukong/ai";

import {
  PipelineStepBusyError,
  runListingPipeline,
} from "./listing-pipeline.js";
import { draftId, makeHarness, workspaceId } from "./pipeline-test-support.js";

const input = { workspaceId, draftId, activeVersionSequence: 0 };

/** The error `assertFactsGrounded` raises for a normalized or classified fact. */
function groundingError(): ProviderOutputError {
  return new ProviderOutputError("AI evidence did not support its fact value");
}

/** Mirrors how listing-consumer.ts classifies terminal provider errors. */
const terminalOnFirstDelivery = {
  attempt: 1,
  maxAttempts: 4,
  isTerminalError: (error: unknown) => error instanceof ProviderOutputError,
};

describe("a deterministic grounding rejection", () => {
  it("fails the listing on the first delivery, without spending the retry budget", async () => {
    const { deps, state } = makeHarness({ extractError: groundingError() });

    await expect(
      runListingPipeline(input, deps, terminalOnFirstDelivery),
    ).rejects.toThrow(ProviderOutputError);

    // attempt 1 of 4, yet already terminal -- the operator gets no interval in
    // which the listing is merely "processing" and might still recover.
    expect(state.status).toBe("failed");
    expect(state.failure).toBe("provider_failure");
  });

  it("discards everything the model did read off the label", async () => {
    const { deps, state } = makeHarness({ extractError: groundingError() });

    await expect(
      runListingPipeline(input, deps, terminalOnFirstDelivery),
    ).rejects.toThrow(ProviderOutputError);

    // No version, and no completed run either -- so there is no server-side
    // record a review page could read partial facts back out of. A single
    // ungroundable fact discards every fact extracted alongside it.
    expect(state.versions).toEqual([]);
    expect(state.completed).toBeUndefined();
  });

  it("writes no extraction telemetry, leaving the failure undiagnosable", async () => {
    const { deps, state } = makeHarness({ extractError: groundingError() });

    await expect(
      runListingPipeline(input, deps, terminalOnFirstDelivery),
    ).rejects.toThrow(ProviderOutputError);

    // aiRuns.append only runs on the success path. The provider call was made
    // and billed, but it appears in neither the cost ledger nor the evidence
    // an admin would use to explain the failure. The audit trail records only
    // that something failed, not which fact was rejected.
    expect(state.aiRuns).toEqual([]);
    expect(state.audits).toContain("listing.pipeline_failed");
  });

  it("keeps holding the extraction step lease after failing terminally", async () => {
    const extract = vi.fn().mockRejectedValue(groundingError());
    const { deps, state } = makeHarness();
    deps.ai = {
      extract,
      async generate() {
        throw new Error("generation must never be reached");
      },
    };

    await expect(
      runListingPipeline(input, deps, terminalOnFirstDelivery),
    ).rejects.toThrow(ProviderOutputError);
    expect(state.status).toBe("failed");

    // pipelineRuns.fail() marks the RUN failed but never deletes the step row
    // (packages/db/src/repositories/pipeline-runs.ts), and claimStep only
    // reclaims a running step once it is older than PIPELINE_STEP_LEASE_MS.
    // So for the next five minutes the step still reads as owned, and a
    // redelivery is refused before the provider is ever consulted.
    await expect(
      runListingPipeline(input, deps, terminalOnFirstDelivery),
    ).rejects.toThrow(PipelineStepBusyError);

    expect(extract).toHaveBeenCalledTimes(1);
    expect(state.versions).toEqual([]);
  });
});
