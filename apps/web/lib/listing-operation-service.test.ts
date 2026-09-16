import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { acceptListingOperation } from "./listing-operation-service";

describe("durable listing operation acceptance", () => {
  beforeEach(() => vi.stubEnv("AI_PROVIDER", "fake"));
  afterEach(() => vi.unstubAllEnvs());
  function fixture() {
    const snapshot = {
      revision: 1,
      baseVersionId: null,
      inputDigest: "input",
      note: "",
      sources: [],
      workingContent: {},
      fieldStates: {},
    };
    const accepted = {
      id: "run-1",
      idempotencyKey: "listing-run:run-1",
      inputRevision: 1,
      baseVersionId: null,
      runAttempt: 1,
      executionState: "queued",
      activeVersionSequence: 0,
    };
    const repos = {
      listings: {
        lockReviewState: vi.fn(),
        getById: vi.fn().mockResolvedValue({
          id: "draft",
          status: "failed",
          activeVersionId: null,
        }),
        requireById: vi.fn().mockResolvedValue({ activeVersionSequence: 0 }),
      },
      listingInputs: { getCurrent: vi.fn().mockResolvedValue(snapshot) },
      pipelineRuns: { acceptOperation: vi.fn().mockResolvedValue(accepted) },
      dispatchOutbox: { record: vi.fn().mockResolvedValue([{ id: "outbox" }]) },
      audit: { write: vi.fn() },
    };
    return { repos, accepted };
  }
  const input = {
    workspaceId: "ws",
    listingId: "draft",
    expectedInputRevision: 1,
    baseVersionId: null,
    operationKey: "request",
    actorId: "operator",
  };
  it("records accepted identity and dispatch intent inside the caller transaction", async () => {
    const { repos } = fixture();
    const result = await acceptListingOperation(repos as never, input);
    expect(result.processing).toMatchObject({
      runId: "run-1",
      state: "queued",
    });
    expect(repos.dispatchOutbox.record).toHaveBeenCalledWith([
      expect.objectContaining({
        dedupeKey: "listing-run:run-1",
        payload: expect.objectContaining({ runId: "run-1", inputRevision: 1 }),
      }),
    ]);
    expect(repos.listings.lockReviewState).toHaveBeenCalledWith("draft");
  });
  it("rejects stale input before recording paid or queued work", async () => {
    const { repos } = fixture();
    await expect(
      acceptListingOperation(repos as never, {
        ...input,
        expectedInputRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "input_revision_conflict" });
    expect(repos.pipelineRuns.acceptOperation).not.toHaveBeenCalled();
    expect(repos.dispatchOutbox.record).not.toHaveBeenCalled();
  });
  it("also rejects a changed editorial version", async () => {
    const { repos } = fixture();
    await expect(
      acceptListingOperation(repos as never, {
        ...input,
        baseVersionId: "newer",
      }),
    ).rejects.toMatchObject({ code: "base_version_conflict" });
  });
  it("does not enqueue paid work without explicit model and budget setup", async () => {
    const { repos } = fixture();
    vi.stubEnv("AI_PROVIDER", "openai");
    await expect(
      acceptListingOperation(repos as never, input),
    ).rejects.toMatchObject({ code: "ai_configuration_required" });
    expect(repos.pipelineRuns.acceptOperation).not.toHaveBeenCalled();
  });
  it("reserves the conservative four-call ceiling before outbox dispatch", async () => {
    const { repos } = fixture();
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("LISTING_PAID_OPERATIONS_ENABLED", "true");
    const policy = {
      provider: "openai",
      model: "gpt-4o",
      pricingVersion: "2026-09",
      runCeilingUsd: "2",
      budgetCapUsd: "10",
      maxInputTokens: 128000,
      maxOutputTokens: 1000,
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 10,
    };
    const reserve = vi
      .fn()
      .mockResolvedValue({ accepted: true, state: "held" });
    await acceptListingOperation(
      {
        ...repos,
        workspaces: { requireProfile: async () => ({ listingAi: policy }) },
        aiBudgetReservations: { reserve },
      } as never,
      input,
    );
    expect(reserve).toHaveBeenCalledWith({
      pipelineRunId: "run-1",
      reservedUsd: "1.320000",
      workspaceCapUsd: "10",
      pricingVersion: "2026-09",
    });
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      repos.dispatchOutbox.record.mock.invocationCallOrder[0]!,
    );
    expect(repos.pipelineRuns.acceptOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          aiPolicy: policy,
          provider: "openai",
        }),
      }),
    );
  });
});
