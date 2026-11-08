import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../../../lib/studio/route-deps";
import {
  answeredTurnOptions,
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  fakeStudioThread,
  type FakeStudioOptions,
} from "../../../../../../lib/studio/test-fakes";
import { createStudioMessageHandler } from "./route";

/**
 * Route-contract tests for `POST /api/studio/threads/[id]/messages`
 * (plan Task 6): strict body, operator floor, flag/thread 404s and one
 * composed reply per clientMessageId.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const THREAD = fakeStudioThread({
  workspaceId: "ws_test",
  createdBy: "actor_ops",
  title: "Conversation",
});

function fixture(
  input: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    options?: FakeStudioOptions;
    env?: NodeJS.ProcessEnv;
    threadId?: string;
  } = {},
) {
  const fake = createFakeStudio({
    ...answeredTurnOptions(),
    ...(input.options ?? {}),
    threads: [THREAD, ...(input.options?.threads ?? [])],
    settings: { workspaceId: "ws_test", enabled: true },
  });
  const session = fakeSessionContext(input.role ?? "operator");
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  const handler = createStudioMessageHandler(deps);
  const threadId = input.threadId ?? THREAD.id;
  return {
    handler: (body: unknown) =>
      handler(
        new Request(
          `http://localhost/api/studio/threads/${threadId}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
        { params: Promise.resolve({ id: threadId }) },
      ),
    fake,
  };
}

const validBody = {
  clientMessageId: "client-1",
  text: "margaux",
  locale: "en",
};

describe("POST /api/studio/threads/[id]/messages", () => {
  it("runs one deterministic turn and returns the composed reply", async () => {
    const { handler, fake } = fixture();
    const response = await handler(validBody);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      threadId: string;
      messageId: string;
      runId: string;
      reply: { status: string; skillKey: string; analysis: unknown };
      trace: Array<{ kind: string }>;
      replayed: boolean;
    };
    expect(body.threadId).toBe(THREAD.id);
    expect(body.messageId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.reply.status).toBe("answered");
    expect(body.reply.skillKey).toBe("catalog.find");
    expect(body.reply.analysis).toBeNull();
    expect(body.trace.map((step) => step.kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "tool",
    ]);
    expect(body.replayed).toBe(false);
    expect(
      fake.state.messages.filter((message) => message.threadId === THREAD.id),
    ).toHaveLength(2);
  });

  it("replays the same clientMessageId without a second run", async () => {
    const { handler, fake } = fixture();
    const first = (await (await handler(validBody)).json()) as {
      messageId: string;
      runId: string;
    };
    const response = await handler(validBody);
    expect(response.status).toBe(200);
    const second = (await response.json()) as {
      messageId: string;
      runId: string;
      replayed: boolean;
    };
    expect(second.replayed).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(second.runId).toBe(first.runId);
    expect(fake.state.runs).toHaveLength(1);
  });

  it("rejects invalid bodies with 400 before any write", async () => {
    const { handler, fake } = fixture();
    const invalidBodies: unknown[] = [
      {},
      { clientMessageId: "client-1", text: "hi" },
      { clientMessageId: "client-1", text: "hi", locale: "fr" },
      { clientMessageId: "", text: "hi", locale: "en" },
      { clientMessageId: "client-1", text: "", locale: "en" },
      {
        clientMessageId: "client-1",
        text: "x".repeat(2001),
        locale: "en",
      },
      {
        clientMessageId: "client-1",
        text: "hi",
        locale: "en",
        attachmentAssetIds: Array.from(
          { length: 9 },
          (_, index) => `a-${index}`,
        ),
      },
      { ...validBody, workspaceId: "foreign" },
    ];
    for (const body of invalidBodies) {
      const response = await handler(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_body" });
    }
    expect(fake.state.writes).not.toContain("messages.append");
    expect(fake.state.writes).not.toContain("runs.create");
  });

  it("returns 403 for a viewer", async () => {
    const { handler, fake } = fixture({ role: "viewer" });
    const response = await handler(validBody);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "insufficient_role",
    });
    expect(fake.state.writes).not.toContain("messages.append");
  });

  it("returns 404 when Studio is disabled or the thread is foreign", async () => {
    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect((await disabled.handler(validBody)).status).toBe(404);
    expect(disabled.fake.state.writes).not.toContain("messages.append");

    const foreign = fixture({
      threadId: "00000000-0000-4000-8000-000000000000",
    });
    const response = await foreign.handler(validBody);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });
});
