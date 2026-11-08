import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { StudioOutput, StudioOutputVersion } from "@wukong/db";

import { canonicalJson } from "../../../../../../lib/studio/output-service";
import type { StudioRouteDeps } from "../../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "../../../../../../lib/studio/test-fakes";
import { createStudioOutputExportHandler } from "./route";

/**
 * Route-contract tests for `GET /api/studio/outputs/[id]/export` (plan
 * Task 11): canonical JSON with the digest outside the payload, saved/signed-off
 * requirement, staleness 409, foreign 404 and no database/provider dependency.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;
const WORKSPACE = "ws_test";
const OUTPUT_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = new Date("2026-11-08T10:00:00.000Z");

const REPORT_PAYLOAD = {
  schemaVersion: "wukong-merchant-audit/v1",
  asOf: "2026-11-08T10:00:00.000Z",
  listings: [{ status: "approved", count: 1 }],
};
const PAYLOAD_DIGEST = createHash("sha256")
  .update(canonicalJson(REPORT_PAYLOAD))
  .digest("hex");

function outputRow(
  overrides: Partial<StudioOutput> = {},
): StudioOutput {
  return {
    id: OUTPUT_ID,
    workspaceId: WORKSPACE,
    threadId: null,
    runId: null,
    kind: "merchant_audit",
    title: "Merchant audit",
    status: "saved",
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
    payload: REPORT_PAYLOAD,
    contentDigest: PAYLOAD_DIGEST,
    asOf: CREATED_AT,
    scope: { workspaceScoped: true },
    createdBy: "actor_ops",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function fixture(input: {
  options?: FakeStudioOptions;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const fake = createFakeStudio({
    settings: { workspaceId: WORKSPACE, enabled: true },
    outputs: [outputRow()],
    outputVersions: [versionRow()],
    ...(input.options ?? {}),
  });
  const session = fakeSessionContext("reviewer", { workspaceId: WORKSPACE });
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  return { fake, handler: createStudioOutputExportHandler(deps) };
}

function request(digest?: string, id = OUTPUT_ID): Request {
  const url = new URL(`http://localhost/api/studio/outputs/${id}/export`);
  if (digest !== undefined) url.searchParams.set("digest", digest);
  return new Request(url);
}

const context = (id = OUTPUT_ID) => ({ params: Promise.resolve({ id }) });

describe("GET /api/studio/outputs/[id]/export", () => {
  it("returns canonical JSON with the payload digest outside the payload", async () => {
    const { handler } = fixture();
    const response = await handler(request(PAYLOAD_DIGEST), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain(
      `studio-output-${OUTPUT_ID}-r1.json`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");

    const text = await response.text();
    // Canonical form: identical to the sorted-JSON serialization of the packet.
    const parsed = JSON.parse(text) as {
      schemaVersion: string;
      canonicalization: string;
      payloadSha256: string;
      output: { outputId: string; status: string; revision: number };
      payload: unknown;
    };
    expect(canonicalJson(parsed)).toBe(text);
    expect(parsed.schemaVersion).toBe("wukong-studio-output-export/v1");
    expect(parsed.canonicalization).toBe("sorted-json-v1");
    expect(parsed.payloadSha256).toBe(PAYLOAD_DIGEST);
    expect(parsed.output).toMatchObject({
      outputId: OUTPUT_ID,
      status: "saved",
      revision: 1,
    });
    expect(parsed.payload).toEqual(REPORT_PAYLOAD);
  });

  it("exports a signed-off artifact too", async () => {
    const { handler } = fixture({
      options: { outputs: [outputRow({ status: "signed_off" })] },
    });
    expect((await handler(request(PAYLOAD_DIGEST), context())).status).toBe(200);
  });

  it("requires the artifact to be saved or signed off", async () => {
    const draft = fixture({ options: { outputs: [outputRow({ status: "draft" })] } });
    const response = await draft.handler(request(PAYLOAD_DIGEST), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "output_not_saved" });
  });

  it("refuses a stale preview digest", async () => {
    const { handler } = fixture();
    const response = await handler(request("b".repeat(64)), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "output_changed" });
  });

  it("refuses persisted content that no longer matches its stored digest", async () => {
    const { handler } = fixture({
      options: {
        outputVersions: [
          versionRow({
            contentDigest: "c".repeat(64),
          }),
        ],
      },
    });
    const response = await handler(request("c".repeat(64)), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "output_changed" });
  });

  it("requires a valid preview digest", async () => {
    const { handler } = fixture();
    for (const digest of [undefined, "not-a-digest", "a".repeat(63)]) {
      expect((await handler(request(digest), context())).status).toBe(400);
    }
  });

  it("returns 404 for an unknown output and when Studio is disabled", async () => {
    const { handler } = fixture();
    expect(
      (
        await handler(
          request(PAYLOAD_DIGEST, "88888888-8888-4888-8888-888888888888"),
          context("88888888-8888-4888-8888-888888888888"),
        )
      ).status,
    ).toBe(404);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect(
      (await disabled.handler(request(PAYLOAD_DIGEST), context())).status,
    ).toBe(404);
  });
});
