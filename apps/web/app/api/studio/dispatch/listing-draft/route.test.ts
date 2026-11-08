import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  intake: vi.fn(),
}));

vi.mock("../../../../../lib/listing-intake-service", () => ({
  createListingIntake: state.intake,
}));

import type { StudioRouteDeps } from "../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  fakeStudioRun,
  fakeStudioThread,
  type FakeStudioOptions,
} from "../../../../../lib/studio/test-fakes";
import { createStudioDispatchHandler } from "./route";

/**
 * Route-contract tests for `POST /api/studio/dispatch/listing-draft`
 * (plan Task 10): explicit confirmation, operator floor, studio flags,
 * thread/run visibility, and the honest queue state. The intake service is
 * injected as a fake so these tests never touch a database or a queue.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const WORKSPACE = "ws_test";
const ASSET_A = "11111111-1111-4111-8111-111111111111";
const ASSET_B = "22222222-2222-4222-8222-222222222222";

function fixture(input: {
  role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
  env?: NodeJS.ProcessEnv;
  options?: FakeStudioOptions;
  intakeResult?: Record<string, unknown>;
  intakeThrows?: Error;
}) {
  const thread = fakeStudioThread({
    workspaceId: WORKSPACE,
    createdBy: "actor_ops",
    title: "Synthetic dispatch thread",
    skillKey: "listing.draft_from_sources",
  });
  const run = fakeStudioRun({
    threadId: thread.id,
    triggerMessageId: "message-1",
    skillKey: "listing.draft_from_sources",
    workspaceId: WORKSPACE,
  });
  const fake = createFakeStudio({
    settings: { workspaceId: WORKSPACE, enabled: true },
    threads: [thread],
    runs: [run],
    ...(input.options ?? {}),
  });
  state.intake.mockReset();
  if (input.intakeThrows) state.intake.mockRejectedValue(input.intakeThrows);
  else
    state.intake.mockResolvedValue(
      input.intakeResult ?? {
        listing: { id: "listing-created", status: "received", target: "shopline" },
        inputRevision: 1,
        activeVersionId: null,
        processing: {
          runId: "run-listing-1",
          jobId: "job-1",
          state: "queued",
          pollAfterMs: 1000,
        },
        replayed: false,
        reusedExisting: false,
        queueState: "enqueued",
      },
    );
  const session = fakeSessionContext(input.role ?? "operator", {
    workspaceId: WORKSPACE,
  });
  const deps: StudioRouteDeps & {
    publisher: { enqueue: (input: unknown) => Promise<{ id: string }> };
  } = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
    publisher: { enqueue: async () => ({ id: "job-1" }) },
  };
  return { fake, deps, thread, run };
}

function request(body: unknown): Request {
  return new Request(
    "http://localhost/api/studio/dispatch/listing-draft",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function validBody(threadId: string, runId?: string) {
  return {
    threadId,
    ...(runId ? { runId } : {}),
    assetIds: [ASSET_A, ASSET_B],
    note: "Create the draft",
    skillKey: "listing.draft_from_sources",
    confirmed: true,
  };
}

describe("POST /api/studio/dispatch/listing-draft", () => {
  it("requires explicit confirmation, at least one asset and a strict body", async () => {
    const { deps, thread } = fixture({});
    const handler = createStudioDispatchHandler(deps);

    for (const body of [
      { ...validBody(thread.id), confirmed: false },
      { ...validBody(thread.id), confirmed: undefined },
      {
        ...validBody(thread.id),
        assetIds: [],
      },
      {
        ...validBody(thread.id),
        assetIds: [ASSET_A, ASSET_A],
      },
      { ...validBody(thread.id), extra: "no" },
      { ...validBody(thread.id), threadId: "not-a-uuid" },
    ]) {
      const response = await handler(request(body));
      expect(response.status).toBe(400);
    }
    expect(state.intake).not.toHaveBeenCalled();
  });

  it("refuses a viewer and a disabled Studio before the intake", async () => {
    const viewer = fixture({ role: "viewer" });
    expect(
      (await createStudioDispatchHandler(viewer.deps)(
        request(validBody(viewer.thread.id)),
      )).status,
    ).toBe(403);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect(
      (await createStudioDispatchHandler(disabled.deps)(
        request(validBody(disabled.thread.id)),
      )).status,
    ).toBe(404);
    expect(state.intake).not.toHaveBeenCalled();
  });

  it("404s a foreign thread and a run that belongs to another thread", async () => {
    const { deps, thread } = fixture({});
    const handler = createStudioDispatchHandler(deps);

    const foreign = await handler(
      request(validBody("99999999-9999-4999-8999-999999999999")),
    );
    expect(foreign.status).toBe(404);

    const otherThread = fakeStudioThread({
      workspaceId: WORKSPACE,
      createdBy: "actor_ops",
      title: "Other",
    });
    const otherRun = fakeStudioRun({
      threadId: otherThread.id,
      triggerMessageId: "message-2",
    });
    const mismatched = await handler(
      request(validBody(thread.id, otherRun.id)),
    );
    expect(mismatched.status).toBe(404);
    expect(state.intake).not.toHaveBeenCalled();
  });

  it("dispatches through the intake service, audits and records the trace event", async () => {
    const { deps, fake, thread, run } = fixture({});
    const handler = createStudioDispatchHandler(deps);

    const response = await handler(request(validBody(thread.id, run.id)));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      listingId: "listing-created",
      runId: "run-listing-1",
      queueState: "enqueued",
      replayed: false,
    });

    expect(state.intake).toHaveBeenCalledTimes(1);
    const [intakeDeps, intakeInput] = state.intake.mock.calls[0] as [
      unknown,
      {
        context: { workspaceId: string };
        body: { sourceAssetIds: string[]; note: string; processingMode: string };
        requestKey: string | null;
      },
    ];
    expect(intakeDeps).toMatchObject({ publisher: expect.anything() });
    expect(intakeInput.context.workspaceId).toBe(WORKSPACE);
    expect(intakeInput.body).toMatchObject({
      sourceAssetIds: [ASSET_A, ASSET_B],
      note: "Create the draft",
      processingMode: "ai",
    });
    expect(intakeInput.requestKey).toBeNull();

    const audit = fake.state.audits.find(
      (event) => event.action === "studio.dispatch.listing_draft",
    );
    expect(audit?.metadata).toMatchObject({
      threadId: thread.id,
      listingId: "listing-created",
      queueState: "enqueued",
      assetCount: 2,
    });
    expect(fake.state.runEvents).toHaveLength(1);
    expect(fake.state.runEvents[0]).toMatchObject({
      runId: run.id,
      kind: "dispatch",
      state: "done",
      payload: {
        key: "studio.trace.dispatch.done",
        values: { listingId: "listing-created", queueState: "enqueued" },
      },
    });
  });

  it("reports queue_unavailable without claiming processing", async () => {
    const { deps, thread } = fixture({
      intakeResult: {
        listing: { id: "listing-created", status: "received", target: "shopline" },
        inputRevision: 1,
        activeVersionId: null,
        processing: null,
        processingBlocked: { code: "ai_configuration_required", message: "x" },
        replayed: false,
        reusedExisting: false,
        queueState: "queue_unavailable",
      },
    });
    const response = await createStudioDispatchHandler(deps)(
      request(validBody(thread.id)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      listingId: "listing-created",
      runId: null,
      queueState: "queue_unavailable",
    });
  });

  it("does not audit or duplicate a replayed dispatch", async () => {
    const { deps, fake, thread } = fixture({
      intakeResult: {
        listing: { id: "listing-created", status: "received", target: "shopline" },
        inputRevision: 1,
        activeVersionId: null,
        processing: null,
        replayed: true,
        reusedExisting: false,
        queueState: "enqueued",
      },
    });
    const response = await createStudioDispatchHandler(deps)(
      request(validBody(thread.id)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: true });
    expect(
      fake.state.audits.filter(
        (event) => event.action === "studio.dispatch.listing_draft",
      ),
    ).toHaveLength(0);
  });

  it("passes an intake 404 through as 404 and an unexpected failure as 500", async () => {
    const { ApiError } = await import("../../../../../lib/route-support");
    const notFoundFixture = fixture({
      intakeThrows: new ApiError(404, "source_assets_not_found", "missing"),
    });
    expect(
      (await createStudioDispatchHandler(notFoundFixture.deps)(
        request(validBody(notFoundFixture.thread.id)),
      )).status,
    ).toBe(404);

    const broken = fixture({ intakeThrows: new Error("boom") });
    expect(
      (await createStudioDispatchHandler(broken.deps)(
        request(validBody(broken.thread.id)),
      )).status,
    ).toBe(500);
  });

  it("refuses a skill the workspace has not allowed", async () => {
    const { deps, thread } = fixture({
      options: { settings: { workspaceId: WORKSPACE, allowedSkills: ["catalog.find"] } },
    });
    const response = await createStudioDispatchHandler(deps)(
      request(validBody(thread.id)),
    );
    expect(response.status).toBe(403);
    expect(state.intake).not.toHaveBeenCalled();
  });
});
