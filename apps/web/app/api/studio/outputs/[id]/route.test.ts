import { describe, expect, it } from "vitest";

import type { StudioOutput, StudioOutputVersion } from "@wukong/db";

import type { StudioRouteDeps } from "../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  reviewSnapshot,
  reviewableContent,
  type FakeStudioOptions,
} from "../../../../../lib/studio/test-fakes";
import { createStudioOutputHandler } from "./route";
import { outputPayloadDigest } from "../../../../../lib/studio/output-service";

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
const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_PAYLOAD = {
  listingId: LISTING_ID,
  activeVersionId: "version-1",
  activeVersionSequence: 1,
  fields: [],
  limitations: [],
  asOf: CREATED_AT.toISOString(),
};
const PIN = {
  expectedRevision: 1,
  expectedDigest: outputPayloadDigest(PROPOSAL_PAYLOAD),
};

function outputRow(overrides: Partial<StudioOutput> = {}): StudioOutput {
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
    payload: PROPOSAL_PAYLOAD,
    contentDigest: PIN.expectedDigest,
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
    snapshots: {
      [LISTING_ID]: reviewSnapshot({
        listingId: LISTING_ID,
        content: reviewableContent(),
      }),
    },
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
    const saved = await save.handlers.POST(
      request({ action: "save", ...PIN }),
      context,
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      outputId: OUTPUT_ID,
      status: "saved",
      version: 1,
    });
    expect(save.fake.state.outputs[0]?.status).toBe("saved");
    expect(save.fake.state.audits.map((event) => event.action)).toContain(
      "studio.output.saved",
    );

    const sign = fixture({ role: "reviewer" });
    const signed = await sign.handlers.POST(
      request({ action: "sign_off", ...PIN }),
      context,
    );
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ status: "signed_off" });
    expect(sign.fake.state.audits.map((event) => event.action)).toContain(
      "studio.output.signed_off",
    );
  });

  it("requires a preview pin and rejects a stale revision or digest without mutation", async () => {
    const { handlers, fake } = fixture({});
    for (const body of [
      { action: "save" },
      { action: "save", ...PIN, expectedRevision: 2 },
      { action: "sign_off", ...PIN, expectedDigest: "b".repeat(64) },
    ]) {
      expect((await handlers.POST(request(body), context)).status).toBe(409);
    }
    expect(fake.state.outputs[0]?.status).toBe("draft");
    expect(fake.state.audits).toEqual([]);
    expect(fake.state.writes).not.toContain("outputs.setStatus");
  });

  it("rejects altered payloads even when the preview matches the stored digest column", async () => {
    const { handlers, fake } = fixture({
      options: {
        outputVersions: [
          versionRow({
            payload: {
              ...PROPOSAL_PAYLOAD,
              limitations: ["altered after persistence"],
            },
          }),
        ],
      },
    });
    for (const action of ["save", "sign_off"])
      expect(
        (await handlers.POST(request({ action, ...PIN }), context)).status,
      ).toBe(409);
    expect(fake.state.audits).toEqual([]);
    expect(fake.state.writes).not.toContain("outputs.setStatus");
    const readback = await handlers.GET(new Request("http://x"), context);
    expect((await readback.json()).output).toMatchObject({
      confirmation: null,
      freshness: "unavailable",
    });
  });

  it("replays a matching confirmation without another status write or audit", async () => {
    const { handlers, fake } = fixture({ role: "operator" });
    const first = await handlers.POST(
      request({ action: "save", ...PIN }),
      context,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      version: 1,
      contentDigest: PIN.expectedDigest,
      replayed: false,
    });
    const second = await handlers.POST(
      request({ action: "save", ...PIN }),
      context,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      version: 1,
      contentDigest: PIN.expectedDigest,
      replayed: true,
    });
    expect(
      fake.state.writes.filter((entry) => entry === "outputs.setStatus"),
    ).toHaveLength(1);
    expect(fake.state.audits).toHaveLength(1);
    expect(fake.state.audits[0]?.metadata).toMatchObject({
      revision: 1,
      contentDigest: PIN.expectedDigest,
    });
  });

  it("rejects sign-off after a listing version changes while retaining save for history", async () => {
    const { handlers, fake } = fixture({
      options: {
        snapshots: {
          [LISTING_ID]: reviewSnapshot({
            listingId: LISTING_ID,
            versionId: "version-2",
            sequence: 2,
            content: reviewableContent(),
          }),
        },
      },
    });
    const rejected = await handlers.POST(
      request({ action: "sign_off", ...PIN }),
      context,
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "proposal_outdated" });
    expect(fake.state.audits).toEqual([]);
    expect(
      (await handlers.POST(request({ action: "save", ...PIN }), context))
        .status,
    ).toBe(200);
    const readback = await handlers.GET(new Request("http://x"), context);
    expect((await readback.json()).output).toMatchObject({
      status: "saved",
      freshness: "stale",
    });
  });

  it("blocks sign-off when the target listing cannot be read", async () => {
    const { handlers, fake } = fixture({ options: { snapshots: {} } });
    expect(
      (await handlers.POST(request({ action: "sign_off", ...PIN }), context))
        .status,
    ).toBe(409);
    expect(fake.state.audits).toEqual([]);
    expect(fake.state.writes).not.toContain("outputs.setStatus");
  });

  it("does not inherit an unconfirmed legacy approval and permits an explicit pinned review", async () => {
    const { handlers, fake } = fixture({
      options: { outputs: [outputRow({ status: "signed_off" })] },
    });
    const legacy = await handlers.GET(new Request("http://x"), context);
    expect((await legacy.json()).output.confirmation).toBeNull();
    expect(
      (await handlers.POST(request({ action: "sign_off", ...PIN }), context))
        .status,
    ).toBe(200);
    const confirmed = await handlers.GET(new Request("http://x"), context);
    expect((await confirmed.json()).output.confirmation).toEqual({
      status: "signed_off",
      revision: 1,
      contentDigest: PIN.expectedDigest,
    });
    expect(
      (await handlers.POST(request({ action: "sign_off", ...PIN }), context))
        .status,
    ).toBe(200);
    expect(fake.state.audits).toHaveLength(1);
  });

  it("never signs off a newer artifact version with a previous preview", async () => {
    const { handlers, fake } = fixture({
      options: {
        outputs: [outputRow({ currentVersion: 2 })],
        outputVersions: [
          versionRow(),
          versionRow({ revision: 2, contentDigest: "b".repeat(64) }),
        ],
      },
    });
    expect(
      (await handlers.POST(request({ action: "sign_off", ...PIN }), context))
        .status,
    ).toBe(409);
    expect(fake.state.outputs[0]?.status).toBe("draft");
    expect(fake.state.audits).toEqual([]);
  });

  it("rejects a viewer sign-off, an invalid body and a disabled Studio", async () => {
    const viewer = fixture({ role: "viewer" });
    expect(
      (
        await viewer.handlers.POST(
          request({ action: "sign_off", ...PIN }),
          context,
        )
      ).status,
    ).toBe(403);
    expect(viewer.fake.state.outputs[0]?.status).toBe("draft");

    const reviewer = fixture({ role: "reviewer" });
    for (const body of [{}, { action: "approve" }, { action: "save", x: 1 }])
      expect(
        (await reviewer.handlers.POST(request(body), context)).status,
      ).toBe(400);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect(
      (
        await disabled.handlers.POST(
          request({ action: "save", ...PIN }),
          context,
        )
      ).status,
    ).toBe(404);
  });
});
