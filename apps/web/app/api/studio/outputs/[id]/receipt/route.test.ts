import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { StudioOutput, StudioOutputVersion } from "@wukong/db";

import { canonicalJson } from "../../../../../../lib/studio/output-service";
import {
  exportReceiptMessage,
  signStudioExportReceipt,
} from "../../../../../../lib/studio/export-receipt";
import type { StudioRouteDeps } from "../../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "../../../../../../lib/studio/test-fakes";
import { createStudioOutputReceiptHandler } from "./route";

/**
 * Route-contract tests for `GET /api/studio/outputs/[id]/receipt` (B3
 * follow-up): the same gate/status/digest/re-hash rules as the export route,
 * an explicit unsigned state without a key, and a server-computed HMAC receipt
 * that verifies with node:crypto and never includes key material.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;
const WORKSPACE = "ws_test";
const OUTPUT_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = new Date("2026-11-08T10:00:00.000Z");
const AS_OF = "2026-11-08T10:00:00.000Z";
const SCHEMA_VERSION = "wukong-studio-output-export/v1";

const SIGNING_KEY_HEX = "a".repeat(64);
const SIGNING_KEY = Buffer.from(SIGNING_KEY_HEX, "hex");

const REPORT_PAYLOAD = {
  schemaVersion: "wukong-merchant-audit/v2",
  asOf: AS_OF,
  period: null,
  attemptsInPeriod: null,
  listings: [{ status: "approved", count: 1 }],
};
const PAYLOAD_DIGEST = createHash("sha256")
  .update(canonicalJson(REPORT_PAYLOAD))
  .digest("hex");

function outputRow(overrides: Partial<StudioOutput> = {}): StudioOutput {
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

function fixture(
  input: {
    options?: FakeStudioOptions;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
  } = {},
) {
  const fake = createFakeStudio({
    settings: { workspaceId: WORKSPACE, enabled: true },
    outputs: [outputRow()],
    outputVersions: [versionRow()],
    ...(input.options ?? {}),
  });
  const session = fakeSessionContext(input.role ?? "viewer", {
    workspaceId: WORKSPACE,
  });
  const deps: StudioRouteDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
    ...(input.now ? { now: input.now } : {}),
  };
  return { fake, handler: createStudioOutputReceiptHandler(deps) };
}

function request(digest?: string, id = OUTPUT_ID): Request {
  const url = new URL(`http://localhost/api/studio/outputs/${id}/receipt`);
  if (digest !== undefined) url.searchParams.set("digest", digest);
  return new Request(url);
}

const context = (id = OUTPUT_ID) => ({ params: Promise.resolve({ id }) });

describe("GET /api/studio/outputs/[id]/receipt", () => {
  it("returns an explicit unsigned state when no signing key is configured", async () => {
    const { handler } = fixture();
    const response = await handler(request(PAYLOAD_DIGEST), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      payloadSha256: PAYLOAD_DIGEST,
      outputId: OUTPUT_ID,
      revision: 1,
      asOf: AS_OF,
      keyConfigured: false,
      signed: false,
      receipt: null,
    });
    expect(JSON.stringify(body)).not.toContain(SIGNING_KEY_HEX);
  });

  it("returns a verifiable HMAC receipt without exposing the key", async () => {
    const signedAt = new Date("2026-11-08T11:00:00.000Z");
    const { handler } = fixture({
      env: {
        ...ON_ENV,
        STUDIO_EXPORT_SIGNING_KEY: SIGNING_KEY_HEX,
        STUDIO_EXPORT_SIGNING_KEY_ID: "pilot-test",
      } as unknown as NodeJS.ProcessEnv,
      now: () => signedAt,
    });
    const response = await handler(request(PAYLOAD_DIGEST), context());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SIGNING_KEY_HEX);
    const body = JSON.parse(text) as {
      keyConfigured: boolean;
      signed: boolean;
      receipt: {
        alg: string;
        keyId: string;
        signedAt: string;
        payloadSha256: string;
        signature: string;
      };
    };
    expect(body.keyConfigured).toBe(true);
    expect(body.signed).toBe(true);
    expect(body.receipt).toMatchObject({
      alg: "HMAC-SHA256",
      keyId: "pilot-test",
      signedAt: signedAt.toISOString(),
      payloadSha256: PAYLOAD_DIGEST,
    });
    const expected = createHmac("sha256", SIGNING_KEY)
      .update(
        exportReceiptMessage({
          schemaVersion: SCHEMA_VERSION,
          payloadSha256: PAYLOAD_DIGEST,
          outputId: OUTPUT_ID,
          revision: 1,
          asOf: AS_OF,
          keyId: "pilot-test",
        }),
      )
      .digest("hex");
    expect(body.receipt.signature).toBe(expected);
    // The shared helper produces exactly the same receipt.
    expect(
      signStudioExportReceipt(SIGNING_KEY, {
        schemaVersion: SCHEMA_VERSION,
        payloadSha256: PAYLOAD_DIGEST,
        outputId: OUTPUT_ID,
        revision: 1,
        asOf: AS_OF,
        keyId: "pilot-test",
        signedAt: signedAt.toISOString(),
      }).signature,
    ).toBe(expected);

    // A different key produces a different signature.
    const other = fixture({
      env: {
        ...ON_ENV,
        STUDIO_EXPORT_SIGNING_KEY: "b".repeat(64),
        STUDIO_EXPORT_SIGNING_KEY_ID: "pilot-test",
      } as unknown as NodeJS.ProcessEnv,
      now: () => signedAt,
    });
    const otherBody = (await (
      await other.handler(request(PAYLOAD_DIGEST), context())
    ).json()) as { receipt: { signature: string } };
    expect(otherBody.receipt.signature).not.toBe(expected);
  });

  it("is readable by a viewer, like the export itself", async () => {
    const { handler } = fixture({ role: "viewer" });
    expect((await handler(request(PAYLOAD_DIGEST), context())).status).toBe(
      200,
    );
  });

  it("requires a valid preview digest", async () => {
    const { handler } = fixture();
    for (const digest of [undefined, "not-a-digest", "a".repeat(63)]) {
      const response = await handler(request(digest), context());
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
  });

  it("refuses a draft artifact as output_not_saved", async () => {
    const { handler } = fixture({
      options: { outputs: [outputRow({ status: "draft" })] },
    });
    const response = await handler(request(PAYLOAD_DIGEST), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "output_not_saved" });
  });

  it("refuses a stale preview digest and a payload that no longer matches its digest", async () => {
    const stale = await fixture().handler(request("b".repeat(64)), context());
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "output_changed" });

    const corrupted = fixture({
      options: {
        outputVersions: [versionRow({ contentDigest: "c".repeat(64) })],
      },
    });
    const response = await corrupted.handler(
      request("c".repeat(64)),
      context(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "output_changed" });
  });

  it("returns 404 for an unknown output and when Studio is disabled", async () => {
    const missing = "88888888-8888-4888-8888-888888888888";
    expect(
      (
        await fixture().handler(
          request(PAYLOAD_DIGEST, missing),
          context(missing),
        )
      ).status,
    ).toBe(404);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect(
      (await disabled.handler(request(PAYLOAD_DIGEST), context())).status,
    ).toBe(404);
  });

  it("fails closed when a signing key is configured but malformed", async () => {
    for (const env of [
      { STUDIO_EXPORT_SIGNING_KEY: "too-short" },
      {
        STUDIO_EXPORT_SIGNING_KEY: SIGNING_KEY_HEX,
        STUDIO_EXPORT_SIGNING_KEY_ID: "bad key id with spaces",
      },
    ]) {
      const { handler } = fixture({
        env: { ...ON_ENV, ...env } as unknown as NodeJS.ProcessEnv,
      });
      const response = await handler(request(PAYLOAD_DIGEST), context());
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        code: "export_signing_misconfigured",
      });
    }
  });
});
