import { describe, expect, it } from "vitest";

import type { StudioOutput } from "@wukong/db";

import type { StudioRouteDeps } from "../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "../../../../lib/studio/test-fakes";
import { createStudioOutputsHandler } from "./route";

/**
 * Route-contract tests for `GET /api/studio/outputs` (plan Task 9): deterministic
 * list, viewer floor and the honest empty state. Fakes only.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;
const WORKSPACE = "ws_test";
const CREATED_AT = new Date("2026-11-08T10:00:00.000Z");

function outputRow(id: string, title: string): StudioOutput {
  return {
    id,
    workspaceId: WORKSPACE,
    threadId: null,
    runId: null,
    kind: "copy_proposal",
    title,
    status: "draft",
    currentVersion: 1,
    createdBy: "actor_ops",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function fixture(input: {
  role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
  options?: FakeStudioOptions;
  env?: NodeJS.ProcessEnv;
}) {
  const fake = createFakeStudio({
    ...(input.options ?? {}),
    settings: { workspaceId: WORKSPACE, enabled: true },
  });
  const session = fakeSessionContext(input.role ?? "viewer", {
    workspaceId: WORKSPACE,
  });
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  return { handlers: createStudioOutputsHandler(deps), fake };
}

describe("GET /api/studio/outputs", () => {
  it("lists versioned artifacts for a viewer", async () => {
    const { handlers } = fixture({
      options: {
        outputs: [
          outputRow("55555555-5555-4555-8555-555555555555", "First"),
          outputRow("66666666-6666-4666-8666-666666666666", "Second"),
        ],
      },
    });
    const response = await handlers(new Request("http://x"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ outputId: string; title: string }>;
      truncated: boolean;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((item) => item.title).sort()).toEqual([
      "First",
      "Second",
    ]);
    expect(body.truncated).toBe(false);
  });

  it("validates kind/status/search query parameters", async () => {
    const { handlers } = fixture({});
    for (const suffix of [
      "?kind=other",
      "?status=other",
      `?q=${"x".repeat(121)}`,
      "?unknown=1",
      "?kind=finding&extra=1",
      "?offset=-1",
      "?offset=100001",
      "?offset=abc",
      "?offset=1.5",
    ]) {
      const response = await handlers(
        new Request(`http://localhost/api/studio/outputs${suffix}`),
      );
      expect(response.status, suffix).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_query" });
    }

    const accepted = await handlers(
      new Request(
        "http://localhost/api/studio/outputs?kind=finding&status=draft&q=pro&offset=50",
      ),
    );
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as {
      items: unknown[];
      offset: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.offset).toBe(50);
  });

  it("returns an honest empty list and 404 when Studio is disabled", async () => {
    const empty = fixture({});
    const body = (await (
      await empty.handlers(new Request("http://x"))
    ).json()) as {
      items: unknown[];
    };
    expect(body.items).toEqual([]);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect((await disabled.handlers(new Request("http://x"))).status).toBe(404);
  });
});
