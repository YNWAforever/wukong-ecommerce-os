import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../index.js";

describe("immutable listing operations", () => {
  const db = createDatabase(
    process.env.TEST_DATABASE_URL ??
      "postgres://wukong_app:wukong-app-local@localhost:54329/wukong",
    {
      migrationUrl:
        process.env.TEST_DATABASE_ADMIN_URL ??
        "postgres://wukong:wukong@localhost:54329/wukong",
    },
  );
  const ws = `operation-${randomUUID()}`;
  beforeAll(() => db.migrate());
  afterAll(() => db.close());
  it("replays the accepted identity and rejects changed payload without rewriting history", async () => {
    await db.forWorkspace(ws, async (repos) => {
      const draft = await repos.listings.create({ target: "shopline" });
      const input = {
        listingId: draft.id,
        inputRevision: 1,
        baseVersionId: null,
        activeVersionSequence: 0,
        requestKey: randomUUID(),
        requestDigest: "one",
        execution: { note: "original" },
      };
      const first = await repos.pipelineRuns.acceptOperation(input);
      const replay = await repos.pipelineRuns.acceptOperation(input);
      expect(replay.id).toBe(first.id);
      expect(first.executionState).toBe("queued");
      expect((await repos.pipelineRuns.getCurrentOperation(draft.id))?.id).toBe(
        first.id,
      );
      await expect(
        repos.pipelineRuns.acceptOperation({ ...input, requestDigest: "two" }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        repos.pipelineRuns.acceptOperation({
          ...input,
          requestKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "processing_already_active" });
    });
  });
  it("creates an immutable retry with explicit parent lineage", async () => {
    await db.forWorkspace(ws, async (repos) => {
      const draft = await repos.listings.create({ target: "shopline" });
      const first = await repos.pipelineRuns.acceptOperation({
        listingId: draft.id,
        inputRevision: 1,
        baseVersionId: null,
        activeVersionSequence: 0,
        requestKey: randomUUID(),
        requestDigest: "first",
        execution: {},
      });
      await repos.pipelineRuns.setOperationState(first.id, "failed", "timeout");
      const retry = await repos.pipelineRuns.acceptOperation({
        listingId: draft.id,
        inputRevision: 1,
        baseVersionId: null,
        activeVersionSequence: 0,
        requestKey: randomUUID(),
        requestDigest: "retry",
        retryOfRunId: first.id,
        execution: {},
      });
      expect(retry.id).not.toBe(first.id);
      expect(retry.retryOfRunId).toBe(first.id);
      expect(retry.runAttempt).toBe(first.runAttempt + 1);
      expect(
        (await repos.pipelineRuns.getOperation(first.id))?.executionState,
      ).toBe("failed");
      expect((await repos.pipelineRuns.getCurrentOperation(draft.id))?.id).toBe(
        retry.id,
      );
    });
  });
  it("terminalizes unfinished steps while preserving completed extraction", async () => {
    await db.forWorkspace(ws, async (repos) => {
      const draft = await repos.listings.create({ target: "shopline" });
      const run = await repos.pipelineRuns.acceptOperation({
        listingId: draft.id,
        inputRevision: 1,
        baseVersionId: null,
        activeVersionSequence: 0,
        requestKey: randomUUID(),
        requestDigest: "terminal-step",
        execution: {},
      });
      const identity = {
        idempotencyKey: run.idempotencyKey,
        listingId: draft.id,
        activeVersionSequence: 0,
      };
      const extraction = await repos.pipelineRuns.claimStep({
        ...identity,
        step: "extracted",
      });
      await repos.pipelineRuns.recordStep({
        ...identity,
        step: "extracted",
        leaseToken: extraction.leaseToken!,
        output: { facts: "retained" },
      });
      const generation = await repos.pipelineRuns.claimStep({
        ...identity,
        step: "generated",
      });
      expect(
        await repos.pipelineRuns.fail({
          ...identity,
          step: "generated",
          leaseToken: generation.leaseToken!,
          errorCode: "provider_timeout",
        }),
      ).toBe(true);
      const state = await repos.pipelineRuns.getState(run.idempotencyKey);
      expect(state?.steps.get("generated")?.state).toBe("failed");
      expect(state?.steps.get("extracted")).toEqual({
        state: "completed",
        output: { facts: "retained" },
      });
    });
  });
  it.each(["cancelled", "superseded"] as const)(
    "revokes live step leases when a run becomes %s",
    async (state) => {
      await db.forWorkspace(ws, async (repos) => {
        const draft = await repos.listings.create({ target: "shopline" });
        const run = await repos.pipelineRuns.acceptOperation({
          listingId: draft.id,
          inputRevision: 1,
          baseVersionId: null,
          activeVersionSequence: 0,
          requestKey: randomUUID(),
          requestDigest: state,
          execution: {},
        });
        const identity = {
          idempotencyKey: run.idempotencyKey,
          listingId: draft.id,
          activeVersionSequence: 0,
        };
        const claim = await repos.pipelineRuns.claimStep({
          ...identity,
          step: "extracted",
        });
        expect(claim.claimed).toBe(true);
        await repos.pipelineRuns.setOperationState(run.id, state);
        expect(
          (await repos.pipelineRuns.getState(run.idempotencyKey))?.steps.get(
            "extracted",
          )?.state,
        ).toBe("failed");
        expect(
          (await repos.pipelineRuns.getOperation(run.id))?.executionState,
        ).toBe(state);
      });
    },
  );
  it("does not expose another workspace's run", async () => {
    const id = await db.forWorkspace(ws, async (repos) => {
      const draft = await repos.listings.create({ target: "shopline" });
      return (
        await repos.pipelineRuns.acceptOperation({
          listingId: draft.id,
          inputRevision: 1,
          baseVersionId: null,
          activeVersionSequence: 0,
          requestKey: randomUUID(),
          requestDigest: "one",
          execution: {},
        })
      ).id;
    });
    expect(
      await db.forWorkspace(`${ws}-foreign`, (repos) =>
        repos.pipelineRuns.getOperation(id),
      ),
    ).toBeNull();
  });
  it("retains late candidates without reopening a superseded operation", async () => {
    await db.forWorkspace(ws, async (repos) => {
      const draft = await repos.listings.create({ target: "shopline" });
      const run = await repos.pipelineRuns.acceptOperation({
        listingId: draft.id,
        inputRevision: 1,
        baseVersionId: null,
        activeVersionSequence: 0,
        requestKey: randomUUID(),
        requestDigest: "snapshot",
        execution: { input: { note: "immutable" } },
      });
      await repos.pipelineRuns.setOperationState(
        run.id,
        "superseded",
        "input_superseded",
      );
      await repos.pipelineRuns.setOperationState(
        run.id,
        "superseded",
        "input_superseded",
        { content: { producer: "candidate" } },
      );
      await repos.pipelineRuns.setOperationState(run.id, "succeeded");
      const stored = await repos.pipelineRuns.getOperation(run.id);
      expect(stored?.executionState).toBe("superseded");
      expect(stored?.execution).toEqual({
        input: { note: "immutable" },
        candidate: { content: { producer: "candidate" } },
      });
    });
  });
  it("stores a tenant-scoped create response independently of later listing changes", async () => {
    const key = randomUUID();
    await db.forWorkspace(ws, async (repos) => {
      await repos.pipelineRuns.lockCreateRequests();
      const draft = await repos.listings.create({
        target: "shopline",
        note: "original",
      });
      await repos.pipelineRuns.recordCreateRequest(
        key,
        "a".repeat(64),
        draft.id,
        { listing: { id: draft.id }, inputRevision: 1 },
      );
      expect(await repos.pipelineRuns.findCreateRequest(key)).toEqual({
        digest: "a".repeat(64),
        response: { listing: { id: draft.id }, inputRevision: 1 },
      });
    });
    expect(
      await db.forWorkspace(ws + "-other", (repos) =>
        repos.pipelineRuns.findCreateRequest(key),
      ),
    ).toBeNull();
  });
});
