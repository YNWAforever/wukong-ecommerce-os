import { describe, expect, it } from "vitest";

import type { StudioOutput, StudioOutputVersion } from "@wukong/db";

import type { StudioRouteDeps } from "../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "../../../../../lib/studio/test-fakes";
import { createStudioOutputHandler } from "./route";

/**
 * Route-contract tests for `GET/POST /api/studio/outputs/[id]` (plan Task 9):
 * strict body validation, role floors, flag-off 404, versioned readback and
 * audit on save/sign-off. Fakes only; no database, no model.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

const WORKSPACE = "ws_test";
const OUTPUT_ID = "55555555-5555-4555-8555-555555555555";
const THREAD_ID = "66666666-6666-4666-8666-666666666666";
const CREATED_AT = new Date("2026-11-08T10:00:00.000Z");

function outputRow(
  overrides: Partial<StudioOutput> = {},
): StudioOutput {
  return {
    id: OUTPUT_ID,
    workspaceId: WORKSPACE,
    threadId: THREAD_ID,
    runId: null,
    kind: "copy_proposal",
    title: "Copy proposal",
    status: "draft",
    currentVersion: 1,
    createdBy: "actor_ops",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function versionRow(
  overrides: Partial<StudioOutputVersion> = {},
): StudioOutputVersion {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    workspaceId: WORKSPACE,
    outputId: OUTPUT_ID,
    revision: 1,
    payload: {
      listingId: "11111111-1111-4111-8111-111111111111",
      fields: [],
    },
    contentDigest: "a".repeat(64),
    asOf: CREATED_AT,
    scope: { listingId: "11111111-1111-4111-8111-111111111111" },
    createdBy: "actor_ops",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function fixture(input: {
  role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
  options?: FakeStudioOptions;
  env?: NodeJS.ProcessEnv;
}) {
  const fake = createFakeStudio({
    outputs: [outputRow()],
    outputVersions: [versionRow()],
    ...(input.options ?? {}),
    settings: { workspaceId: WORKSPACE, enabled: true },
  });
  const session = fakeSessionContext(input.role ?? "reviewer", {
    workspaceId: WORKSPACE,
  });
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  return { handlers: createStudioOutputHandler(deps), fake };
}

const context = { params: Promise.resolve({ id: OUTPUT_ID }) };

function request(body: unknown): Request {
  return new Request(`http://localhost/api/studio/outputs/${OUTPUT_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/studio/outputs/[id]", () => {
  it("returns the artifact and its immutable versions", async () => {
    const { handlers } = fixture({});
    const response = await handlers.GET(new Request("http://x"), context);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      output: { outputId: string; status: string; currentVersion: number };
      versions: Array<{ revision: number; contentDigest: string }>;
    };
    expect(body.output).toMatchObject({
      outputId: OUTPUT_ID,
      status: "draft",
      currentVersion: 1,
    });
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]?.revision).toBe(1);
  });

  it("returns 404 for an unknown output and 404 when Studio is disabled", async () => {
    const { handlers } = fixture({});
    const missing = await handlers.GET(new Request("http://x"), {
      params: Promise.resolve({
        id: "88888888-8888-4888-8888-888888888888",
      }),
    });
    expect(missing.status).toBe(404);

    const disabled = fixture({
      env: {} as NodeJS.ProcessEnv,
    });
    expect(
      (await disabled.handlers.GET(new Request("http://x"), context)).status,
    ).toBe(404);
  });
});

describe("POST /api/studio/outputs/[id]", () => {
  it("saves as operator and signs off as reviewer with audits", async () => {
    const save = fixture({ role: "operator" });
    const saved = await save.handlers.POST(request({ action: "save" }), context);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      outputId: OUTPUT_ID,
      status: "saved",
      version: 1,
    });
    expect(save.fake.state.outputs[0]?.status).toBe("saved");
    expect(
      save.fake.state.audits.map((event) => event.action),
    ).toContain("studio.output.saved");

    const sign = fixture({ role: "reviewer" });
    const signed = await sign.handlers.POST(
      request({ action: "sign_off" }),
      context,
    );
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ status: "signed_off" });
    expect(
      sign.fake.state.audits.map((event) => event.action),
    ).toContain("studio.output.signed_off");
  });

  it("rejects a viewer sign-off, an invalid body and a disabled Studio", async () => {
    const viewer = fixture({ role: "viewer" });
    expect(
      (await viewer.handlers.POST(request({ action: "sign_off" }), context))
        .status,
    ).toBe(403);
    expect(viewer.fake.state.outputs[0]?.status).toBe("draft");

    const reviewer = fixture({ role: "reviewer" });
    for (const body of [{}, { action: "approve" }, { action: "save", x: 1 }])
      expect(
        (await reviewer.handlers.POST(request(body), context)).status,
      ).toBe(400);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect(
      (await disabled.handlers.POST(request({ action: "save" }), context))
        .status,
    ).toBe(404);
  });
});
