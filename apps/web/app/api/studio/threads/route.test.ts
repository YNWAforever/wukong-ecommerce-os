import { describe, expect, it } from "vitest";

import type { StudioRouteDeps } from "../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "../../../../lib/studio/test-fakes";
import { createStudioThreadsHandlers } from "./route";

/**
 * Route-contract tests for `GET/POST /api/studio/threads` (plan Task 6):
 * strict body validation, role floor, flag-off 404 and the success shape.
 * Fakes only; no database, no network.
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
  const session = fakeSessionContext(input.role ?? "operator");
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  return { handlers: createStudioThreadsHandlers(deps), fake };
}

function post(body: unknown, raw = false): Request {
  return new Request("http://localhost/api/studio/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

const list = () => new Request("http://localhost/api/studio/threads");

describe("POST /api/studio/threads", () => {
  it("creates a thread with its audit event and returns the id", async () => {
    const { handlers, fake } = fixture({});
    const response = await handlers.POST(post({ title: "Find margaux" }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      threadId: string;
    };
    expect(body.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(fake.state.threads).toHaveLength(1);
    expect(fake.state.threads[0]?.title).toBe("Find margaux");
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.thread.created",
    ]);
  });

  it("rejects invalid bodies with 400 before any write", async () => {
    const { handlers, fake } = fixture({});
    for (const body of [
      { title: "" },
      { title: "x".repeat(201) },
      { title: 42 },
      { title: "ok", extra: "field" },
    ]) {
      const response = await handlers.POST(post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_body" });
    }
    expect((await handlers.POST(post("not-json", true))).status).toBe(400);
    expect(fake.state.writes).not.toContain("threads.create");
  });

  it("returns 403 for a viewer and 404 when Studio is disabled", async () => {
    const viewer = fixture({ role: "viewer" });
    expect((await viewer.handlers.POST(post({ title: "x" }))).status).toBe(403);
    expect(viewer.fake.state.writes).not.toContain("threads.create");

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    const response = await disabled.handlers.POST(post({ title: "x" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect(disabled.fake.state.writes).not.toContain("threads.create");
  });
});

describe("GET /api/studio/threads", () => {
  it("lists threads created in the workspace", async () => {
    const { handlers } = fixture({ role: "operator" });
    const created = await handlers.POST(post({ title: "One" }));
    const threadId = ((await created.json()) as { threadId: string }).threadId;

    const response = await handlers.GET(list());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ threadId: string; title: string }>;
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.items).toEqual([
      expect.objectContaining({ threadId, title: "One" }),
    ]);
  });

  it("validates the server-side search query parameters", async () => {
    const { handlers } = fixture({ role: "operator" });
    for (const suffix of [
      `?q=${"x".repeat(121)}`,
      "?unknown=1",
      "?q=a&extra=b",
    ]) {
      const response = await handlers.GET(
        new Request(`http://localhost/api/studio/threads${suffix}`),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_query" });
    }

    const accepted = await handlers.GET(
      new Request("http://localhost/api/studio/threads?q=margaux"),
    );
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("returns 401 without a session and 404 when disabled", async () => {
    const anonymous = createStudioThreadsHandlers({
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
    expect((await anonymous.GET(list())).status).toBe(401);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect((await disabled.handlers.GET(list())).status).toBe(404);
  });
});
