import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeMessage,
  fakeSessionContext,
  fakeStudioThread,
  type FakeStudioOptions,
} from "../../../../../lib/studio/test-fakes";
import { createStudioThreadHandler } from "./route";

/**
 * Route-contract tests for `GET /api/studio/threads/[id]` (plan Task 6):
 * persisted JSON content, private/foreign thread invisibility and flag gating.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

function fixture(input: {
  role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
  options?: FakeStudioOptions;
  env?: NodeJS.ProcessEnv;
}) {
  const fake = createFakeStudio({
    ...(input.options ?? {}),
    settings: { workspaceId: "ws_test", enabled: true },
  });
  const session = fakeSessionContext(input.role ?? "viewer");
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  return { handler: createStudioThreadHandler(deps), fake };
}

function requestContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const request = () => new Request("http://localhost/api/studio/threads/x");

describe("GET /api/studio/threads/[id]", () => {
  it("returns the thread and its persisted messages", async () => {
    const thread = fakeStudioThread({
      workspaceId: "ws_test",
      createdBy: "actor_ops",
      title: "Conversation",
    });
    const { handler } = fixture({
      options: {
        threads: [thread],
        messages: [
          fakeMessage({
            threadId: thread.id,
            role: "operator",
            sequence: 1,
            content: { text: "find margaux", locale: "en" },
          }),
          fakeMessage({
            threadId: thread.id,
            role: "assistant",
            sequence: 2,
            content: { status: "answered" },
          }),
        ],
      },
    });
    const response = await handler(request(), requestContext(thread.id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thread: { threadId: string; title: string };
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.thread).toMatchObject({
      threadId: thread.id,
      title: "Conversation",
    });
    expect(body.messages.map((message) => message.role)).toEqual([
      "operator",
      "assistant",
    ]);
    expect(body.messages[0]?.content).toEqual({
      text: "find margaux",
      locale: "en",
    });
  });

  it("returns 404 for unknown, malformed, private and disabled threads", async () => {
    const privateThread = fakeStudioThread({
      workspaceId: "ws_test",
      createdBy: "actor_other",
      title: "Private",
      visibility: "private",
    });
    const { handler } = fixture({ options: { threads: [privateThread] } });

    const unknown = await handler(
      request(),
      requestContext("00000000-0000-4000-8000-000000000000"),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "not_found" });

    expect(
      (await handler(request(), requestContext("not-a-uuid"))).status,
    ).toBe(404);
    expect(
      (await handler(request(), requestContext(privateThread.id))).status,
    ).toBe(404);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect(
      (await disabled.handler(request(), requestContext(privateThread.id)))
        .status,
    ).toBe(404);
  });

  it("returns 401 without a session", async () => {
    const handler = createStudioThreadHandler({
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
    const response = await handler(
      request(),
      requestContext("00000000-0000-4000-8000-000000000000"),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });
});
