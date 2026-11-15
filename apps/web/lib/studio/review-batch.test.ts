import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStudioUsage, type StudioModel } from "@wukong/ai";

import { isStudioAiEnabled, isStudioEnabled } from "../studio-flags";
import { createStudioService } from "./turn-service";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  reviewableContent,
  reviewSnapshot,
  type FakeStudio,
} from "./test-fakes";

/**
 * Bounded multi-listing review (2026-11-16 plan).
 *
 * Fakes only: no provider, no Postgres. The fake records every write, so these
 * tests prove that an over-cap or wrong-role request never creates a thread,
 * that one failed listing never stops the others, and that the batch never
 * reaches a model or reserves budget.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const MISSING = "77777777-7777-4777-8777-777777777777";
const VERSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION_CHANGED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const env = {
  CONVERSATION_STUDIO_ENABLED: "true",
  CONVERSATION_STUDIO_AI_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;
afterEach(() => vi.restoreAllMocks());

/** The deterministic stages must never touch the model; throw if they try. */
function neverCalledModel(): { model: StudioModel; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    model: {
      async plan() {
        calls.push("plan");
        throw new Error("guided review does not plan");
      },
      async compose() {
        calls.push("compose");
        throw new Error("audit and gaps are deterministic");
      },
      async propose() {
        calls.push("propose");
        return {
          proposal: {
            listingId: A,
            activeVersionId: VERSION_A,
            activeVersionSequence: 1,
            fields: [],
            limitations: [],
          },
          usage: fakeStudioUsage({ estimatedCostUsd: 0.02 }),
        };
      },
    },
  };
}

function fixture(
  options: {
    role?: "operator" | "reviewer" | "viewer";
    allowedSkills?: string[];
    omitB?: boolean;
  } = {},
) {
  const snapshots: Record<string, ReturnType<typeof reviewSnapshot>> = {
    [A]: reviewSnapshot({
      listingId: A,
      versionId: VERSION_A,
      sequence: 1,
      content: reviewableContent(),
    }),
  };
  if (!options.omitB) {
    snapshots[B] = reviewSnapshot({
      listingId: B,
      versionId: VERSION_B,
      sequence: 2,
      content: reviewableContent(),
    });
  }
  const fake = createFakeStudio({
    snapshots,
    settings: {
      workspaceId: "ws_test",
      enabled: true,
      allowedSkills: options.allowedSkills ?? [],
      monthlyBudgetUsd: "10",
      runCeilingUsd: "2",
      ai: {
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        pricingVersion: "opencode-go-2026-11",
        maxInputTokens: 1048576,
        inputUsdPerMillion: "0.3",
        outputUsdPerMillion: "1.2",
        maxOutputTokens: 4096,
      },
    },
  });
  const { model, calls } = neverCalledModel();
  const session = fakeSessionContext(options.role ?? "operator", {
    workspaceId: "ws_test",
  });
  const service = createStudioService({
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    isStudioEnabled,
    isStudioAiEnabled,
    env,
    now: () => new Date("2026-11-16T08:00:00Z"),
    createModel: () => model,
  });
  const asViewer = () =>
    createStudioService({
      sessionContext: fakeSessionContext("viewer", {
        workspaceId: "ws_test",
      }).port,
      getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
      isStudioEnabled,
      isStudioAiEnabled,
      env,
      now: () => new Date("2026-11-16T08:00:00Z"),
    });
  return { fake, service, calls, asViewer, snapshots };
}

function recordings(fake: FakeStudio) {
  return fake.state.audits.filter(
    (event) => event.action === "studio.review_batch.processed",
  );
}

describe("startReviewBatch", () => {
  it("runs the audit and gap stages per listing in its own thread, with no model call", async () => {
    const f = fixture();
    const result = await f.service.startReviewBatch({ listingIds: [A, B] });

    expect(result.requested).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.partial).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.items.map((item) => item.listingId)).toEqual([A, B]);
    for (const item of result.items) {
      expect(item.outcome).toBe("complete");
      expect(item.failureCode).toBeNull();
      expect(item.threadId).toEqual(expect.any(String));
      expect(item.audit?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(item.gap?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      // The pin names the exact recorded version, not a newer one.
      const auditVersion = f.fake.state.outputVersions.find(
        (version) =>
          version.outputId === item.audit?.outputId &&
          version.revision === item.audit?.revision,
      );
      expect(auditVersion?.contentDigest).toBe(item.audit?.contentDigest);
    }
    expect(new Set(result.items.map((item) => item.threadId)).size).toBe(2);
    // Deterministic only: no model step and no budget reservation.
    expect(f.calls).toEqual([]);
    expect(f.fake.state.budgets).toEqual([]);

    const [event] = recordings(f.fake);
    expect(event).toBeDefined();
    expect(event?.metadata).toMatchObject({
      batchId: result.batchId,
      requested: 2,
      completed: 2,
      partial: 0,
      failed: 0,
    });
  });

  it("isolates a failed listing instead of aborting the whole review", async () => {
    const f = fixture();
    const result = await f.service.startReviewBatch({
      listingIds: [A, MISSING],
    });

    expect(result.items[0]).toMatchObject({
      listingId: A,
      outcome: "complete",
      failureCode: null,
    });
    expect(result.items[1]).toMatchObject({
      listingId: MISSING,
      outcome: "failed",
      failureCode: "listing_unavailable",
      threadId: null,
      audit: null,
      gap: null,
    });
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
    expect(recordings(f.fake)).toHaveLength(1);
  });

  it("records a listing that changed before the audit as failed, keeping its thread", async () => {
    const f = fixture();
    const evidence = f.snapshots[A]!;
    const changed = reviewSnapshot({
      listingId: A,
      versionId: VERSION_CHANGED,
      sequence: 1,
      content: reviewableContent(),
    });
    vi.spyOn(f.fake.repos.listings, "getReviewSnapshot")
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce(changed);

    const result = await f.service.startReviewBatch({ listingIds: [A] });

    expect(result.items[0]).toMatchObject({
      outcome: "failed",
      failureCode: "listing_changed",
    });
    expect(result.items[0]!.threadId).toEqual(expect.any(String));
    expect(result.items[0]!.audit).toBeNull();
    expect(f.fake.state.threads).toHaveLength(1);
    // The created thread is still the recorded correlation target.
    expect(recordings(f.fake)[0]?.entityId).toBe(result.items[0]!.threadId);
  });

  it("keeps the recorded audit when the gap stage fails", async () => {
    const f = fixture();
    const original = f.fake.repos.studio.outputs.addVersion;
    let versions = 0;
    vi.spyOn(f.fake.repos.studio.outputs, "addVersion").mockImplementation(
      async (input) => {
        versions += 1;
        if (versions === 2) throw new Error("gap write failed");
        return original(input);
      },
    );

    const result = await f.service.startReviewBatch({ listingIds: [A] });

    expect(result.items[0]).toMatchObject({
      outcome: "partial",
      failureCode: "review_unavailable",
    });
    expect(result.items[0]!.audit).not.toBeNull();
    expect(result.items[0]!.gap).toBeNull();
    expect(result.partial).toBe(1);
  });

  it("rejects over-cap, duplicate, empty and caller-controlled selections", async () => {
    const f = fixture();
    for (const body of [
      { listingIds: [A, B, C, D, E, F] },
      { listingIds: [A, A] },
      { listingIds: [] },
      { listingIds: ["not-a-uuid"] },
      { listingIds: [A], workspaceId: "ws_foreign" },
      { listingIds: [A], locale: "fr" },
    ]) {
      await expect(f.service.startReviewBatch(body)).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(f.fake.state.threads).toEqual([]);
    expect(f.fake.state.writes).not.toContain("threads.create");
  });

  it("requires the operator role floor and every guided skill", async () => {
    // `reviewer` sits above `operator` in this product's role order, so the
    // floor only rejects a viewer.
    const denied = fixture({ role: "viewer" });
    await expect(
      denied.service.startReviewBatch({ listingIds: [A] }),
    ).rejects.toMatchObject({ status: 403 });
    expect(denied.fake.state.threads).toEqual([]);
    const gated = fixture({ allowedSkills: ["merchant.audit"] });
    await expect(
      gated.service.startReviewBatch({ listingIds: [A] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(gated.fake.state.threads).toEqual([]);
  });
});

describe("listingReviews", () => {
  it("rebuilds the newest exact stages per listing for a viewer", async () => {
    const f = fixture();
    const started = await f.service.startReviewBatch({
      listingIds: [A, B],
    });
    const viewer = f.asViewer();
    const state = await viewer.listingReviews({ listingIds: `${A},${B}` });

    expect(state.items.map((item) => item.listingId)).toEqual([A, B]);
    for (const [index, item] of state.items.entries()) {
      const startedItem = started.items[index]!;
      expect(item).toMatchObject({
        available: true,
        threadId: startedItem.threadId,
        audit: startedItem.audit,
        gap: startedItem.gap,
      });
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.activeVersion?.versionId).toBe(
        index === 0 ? VERSION_A : VERSION_B,
      );
    }
  });

  it("reports a missing or foreign listing as unavailable without naming it", async () => {
    const f = fixture();
    const state = await f
      .asViewer()
      .listingReviews({ listingIds: `${MISSING},${A}` });

    expect(state.items[0]).toEqual({
      listingId: MISSING,
      available: false,
      title: "",
      status: null,
      activeVersion: null,
      threadId: null,
      audit: null,
      gap: null,
    });
    expect(state.items[1]).toMatchObject({ listingId: A, available: true });
    expect(state.items[1]!.audit).toBeNull();
  });

  it("rejects a viewer's malformed or over-cap query", async () => {
    const f = fixture();
    const viewer = f.asViewer();
    for (const query of [
      {},
      { listingIds: "" },
      { listingIds: `${A},${A}` },
      { listingIds: [A, B, C, D, E, F].join(",") },
      { listingIds: `${A},not-a-uuid` },
      { listingIds: A, extra: "1" },
    ]) {
      await expect(viewer.listingReviews(query)).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});
