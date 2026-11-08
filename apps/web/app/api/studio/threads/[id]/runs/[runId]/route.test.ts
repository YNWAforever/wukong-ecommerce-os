import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  fakeStudioRun,
  fakeStudioThread,
  type FakeStudioOptions,
} from "../../../../../../../lib/studio/test-fakes";
import { createStudioRunHandler } from "./route";

/**
 * Route-contract tests for `GET /api/studio/threads/[id]/runs/[runId]`
 * (plan Task 6): run status plus the ordered persisted trace, 404 for a
 * foreign run and flag gating.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const NOW = new Date("2026-11-08T10:00:00.000Z");

function fixture(
  input: {
    options?: FakeStudioOptions;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const fake = createFakeStudio({
    ...(input.options ?? {}),
    settings: { workspaceId: "ws_test", enabled: true },
  });
  const session = fakeSessionContext("viewer");
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  return { handler: createStudioRunHandler(deps), fake };
}

function requestContext(id: string, runId: string) {
  return { params: Promise.resolve({ id, runId }) };
}

const request = () =>
  new Request("http://localhost/api/studio/threads/x/runs/y");

describe("GET /api/studio/threads/[id]/runs/[runId]", () => {
  it("returns the run and ordered trace events", async () => {
    const thread = fakeStudioThread({
      workspaceId: "ws_test",
      createdBy: "actor_ops",
      title: "Conversation",
    });
    const run = fakeStudioRun({
      threadId: thread.id,
      triggerMessageId: "message-1",
      status: "succeeded",
    });
    const { handler } = fixture({
      options: {
        threads: [thread],
        runs: [run],
        runEvents: [
          {
            id: "event-2",
            workspaceId: "ws_test",
            runId: run.id,
            sequence: 2,
            kind: "tool",
            toolId: "catalog.get",
            state: "done",
            payload: { key: "studio.trace.tool.done", values: {} },
            durationMs: 3,
            createdAt: NOW,
          },
          {
            id: "event-1",
            workspaceId: "ws_test",
            runId: run.id,
            sequence: 1,
            kind: "tool",
            toolId: "catalog.search",
            state: "done",
            payload: { key: "studio.trace.tool.done", values: {} },
            durationMs: 2,
            createdAt: NOW,
          },
        ],
      },
    });
    const response = await handler(
      request(),
      requestContext(thread.id, run.id),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runId: string;
      status: string;
      events: Array<{ sequence: number; toolId: string | null }>;
    };
    expect(body.runId).toBe(run.id);
    expect(body.status).toBe("succeeded");
    expect(body.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(body.events.map((event) => event.toolId)).toEqual([
      "catalog.search",
      "catalog.get",
    ]);
  });

  it("returns 404 for a run in another thread, an unknown id or flag off", async () => {
    const thread = fakeStudioThread({
      workspaceId: "ws_test",
      createdBy: "actor_ops",
      title: "Conversation",
    });
    const otherThread = fakeStudioThread({
      workspaceId: "ws_test",
      createdBy: "actor_ops",
      title: "Other",
    });
    const run = fakeStudioRun({
      threadId: otherThread.id,
      triggerMessageId: "message-1",
    });
    const { handler } = fixture({
      options: { threads: [thread, otherThread], runs: [run] },
    });
    const mismatch = await handler(
      request(),
      requestContext(thread.id, run.id),
    );
    expect(mismatch.status).toBe(404);
    expect(await mismatch.json()).toMatchObject({ code: "not_found" });

    expect(
      (
        await handler(
          request(),
          requestContext(thread.id, "00000000-0000-4000-8000-000000000000"),
        )
      ).status,
    ).toBe(404);
    expect(
      (await handler(request(), requestContext("not-a-uuid", run.id))).status,
    ).toBe(404);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect(
      (await disabled.handler(request(), requestContext(thread.id, run.id)))
        .status,
    ).toBe(404);
  });

  it("returns 401 without a session", async () => {
    const handler = createStudioRunHandler({
      sessionContext: {
        async resolve() {
          return null;
        },
      },
      getDatabase: () => {
        throw new Error("must stay lazy");
      },
      env: ON_ENV,
    });
    expect(
      (
        await handler(
          request(),
          requestContext(
            "00000000-0000-4000-8000-000000000000",
            "00000000-0000-4000-8000-000000000000",
          ),
        )
      ).status,
    ).toBe(401);
  });
});
