import { createHash } from "node:crypto";
import { AssetObjectMissingError } from "@wukong/assets";
import { describe, expect, it } from "vitest";

import { createDownloadExportHandler } from "./route.js";

const context = {
  workspaceId: "ws_opak",
  actorId: "reviewer_1",
  role: "reviewer" as const,
};

const VALID_ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

function request() {
  return new Request(
    `http://localhost/api/listings/export/${VALID_ATTEMPT_ID}/download`,
    { method: "GET" },
  );
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeExportAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_ATTEMPT_ID,
    requestedBy: "reviewer_1",
    manifest: [
      { listingId: "listing_1", versionId: "version_1", outcome: "included" },
    ],
    rowCount: 1,
    specVersion: "bulk_form_v1",
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * The fake `listings` repository reports an active version that has nothing
 * to do with the manifest the fake `exportAttempts.getById` returns --
 * proving the handler never consults live listing state to build the
 * response. If the handler regenerated the workbook instead of reading the
 * stored bytes, it would have to call this to even have a chance of
 * producing the right file.
 */
function makeRepositories(options: { attempt?: unknown } = {}) {
  const attempt = "attempt" in options ? options.attempt : makeExportAttempt();
  return {
    exportAttempts: {
      async getById(id: string) {
        if (!attempt) return null;
        const found = attempt as { id: string };
        return id === found.id ? attempt : null;
      },
    },
    listings: {
      async getReviewSnapshot() {
        return {
          activeVersion: {
            id: "totally_different_version",
            sequence: 99,
            content: { title: { en: "Not this", "zh-Hant": "不是這個" } },
          },
        };
      },
    },
  };
}

function makeAssetStore(
  options: {
    bytes?: Uint8Array;
    throwsOnRead?: boolean;
    throwsUnrelatedError?: boolean;
  } = {},
) {
  const bytes = options.bytes ?? new TextEncoder().encode("fake-xlsx-bytes");
  const calls: { workspaceId: string; key: string }[] = [];
  return {
    calls,
    bytes,
    async readObject(workspaceId: string, key: string) {
      calls.push({ workspaceId, key });
      if (options.throwsOnRead) {
        // Matches the exact error MemoryAssetStore/S3AssetStore throw for a
        // missing object body (packages/assets/src/asset-store.ts,
        // packages/assets/src/s3-asset-store.ts).
        throw new AssetObjectMissingError();
      }
      if (options.throwsUnrelatedError) {
        // A DIFFERENT failure -- e.g. a transient R2/S3 outage, a network
        // failure, a credential misconfiguration -- that happens to also
        // throw out of readObject(), but is not "this object was never
        // written." The route must not mistake this for that case.
        throw new Error("S3: connection reset by peer");
      }
      return bytes;
    },
  };
}

function makeHandler(
  options: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    attempt?: unknown;
    assetStoreOptions?: {
      bytes?: Uint8Array;
      throwsOnRead?: boolean;
      throwsUnrelatedError?: boolean;
    };
  } = {},
) {
  const repositories = makeRepositories(
    "attempt" in options ? { attempt: options.attempt } : {},
  );
  const assetStore = makeAssetStore(options.assetStoreOptions);
  let getDatabaseCalls = 0;

  const handler = createDownloadExportHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: options.role ?? "reviewer" };
      },
    },
    getDatabase: () => {
      getDatabaseCalls += 1;
      return {
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repos: any) => Promise<T>,
        ) {
          return work(repositories);
        },
      };
    },
    getAssetStore: () => assetStore,
  });

  return {
    handler,
    assetStore,
    repositories,
    getDatabaseCalls: () => getDatabaseCalls,
  };
}

describe("GET /api/listings/export/[id]/download", () => {
  it("returns 200 with the exact stored bytes and correct headers for a reviewer", async () => {
    const { handler, assetStore } = makeHandler();
    const response = await handler(request(), routeContext(VALID_ATTEMPT_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="export-${VALID_ATTEMPT_ID}-bulk_form_v1.xlsx"`,
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(assetStore.bytes);
  });

  it.each(["viewer", "operator"] as const)(
    "returns 403 insufficient_role for a %s",
    async (role) => {
      const { handler } = makeHandler({ role });
      const response = await handler(request(), routeContext(VALID_ATTEMPT_ID));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe("insufficient_role");
    },
  );

  it("returns 404 export_attempt_not_found for an unknown or cross-workspace export attempt id", async () => {
    const { handler } = makeHandler({ attempt: null });
    const response = await handler(request(), routeContext(VALID_ATTEMPT_ID));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("export_attempt_not_found");
  });

  it("rejects a malformed export attempt id with 404 before touching the database", async () => {
    const { handler, getDatabaseCalls } = makeHandler();
    const response = await handler(request(), routeContext("not-a-valid-uuid"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("export_attempt_not_found");
    expect(getDatabaseCalls()).toBe(0);
  });

  it("serves whatever bytes the asset store currently holds, unrelated to any other in-memory/live listing state", async () => {
    const { handler, assetStore } = makeHandler();
    const response = await handler(request(), routeContext(VALID_ATTEMPT_ID));
    expect(response.status).toBe(200);
    const body = new Uint8Array(await response.arrayBuffer());
    // The fake listings repository (wired into the same fake db.forWorkspace
    // this handler receives) would report a completely different active
    // version if consulted -- the response must still match the asset
    // store's bytes exactly, proving the handler didn't regenerate anything.
    expect(body).toEqual(assetStore.bytes);
  });

  it("returns a distinct, clean error (not a bare 500, and not the not-found 404) when the attempt row exists but the asset object is missing", async () => {
    const { handler } = makeHandler({
      assetStoreOptions: { throwsOnRead: true },
    });
    const response = await handler(request(), routeContext(VALID_ATTEMPT_ID));
    expect(response.status).not.toBe(500);
    expect(response.status).not.toBe(404);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const body = await response.json();
    expect(body.code).toBe("export_object_missing");
    expect(body.code).not.toBe("export_attempt_not_found");
  });

  it("does not swallow an unrelated asset-store failure (e.g. a transient outage) as export_object_missing", async () => {
    // Only the exact "no stored body" message is the genuinely expected
    // case. Anything else reading out of readObject() -- an outage, a
    // network error, a bad credential -- must propagate to
    // withRouteErrors's normal catch-all (500 + a server-side trace),
    // not get mapped to the misleading "resubmit the export" 409.
    const { handler } = makeHandler({
      assetStoreOptions: { throwsUnrelatedError: true },
    });
    const response = await handler(request(), routeContext(VALID_ATTEMPT_ID));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("internal_error");
  });
});

describe("artifact readiness and provenance", () => {
  it.each(["pending", "failed"])(
    "refuses %s artifacts before reading storage",
    async (artifactStatus) => {
      const { handler, assetStore } = makeHandler({
        attempt: makeExportAttempt({
          provenance: { version: 1 },
          artifactStatus,
          artifactSha256: "a".repeat(64),
        }),
      });
      const response = await handler(request(), routeContext(VALID_ATTEMPT_ID));
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("export_artifact_not_ready");
      expect(assetStore.calls).toHaveLength(0);
    },
  );
  it("verifies ready bytes and marks legacy downloads as incomplete provenance", async () => {
    const bytes = new TextEncoder().encode("fake-xlsx-bytes");
    const { handler } = makeHandler({
      attempt: makeExportAttempt({
        provenance: { version: 1 },
        artifactStatus: "ready",
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    });
    expect(
      (await handler(request(), routeContext(VALID_ATTEMPT_ID))).headers.get(
        "x-export-provenance",
      ),
    ).toBe("complete");
    const legacy = makeHandler();
    expect(
      (
        await legacy.handler(request(), routeContext(VALID_ATTEMPT_ID))
      ).headers.get("x-export-provenance"),
    ).toBe("incomplete");
  });
  it("rejects stored bytes that no longer match the ready artifact", async () => {
    const { handler } = makeHandler({
      attempt: makeExportAttempt({
        provenance: { version: 1 },
        artifactStatus: "ready",
        artifactSha256: "a".repeat(64),
      }),
    });
    const response = await handler(request(), routeContext(VALID_ATTEMPT_ID));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("export_artifact_hash_mismatch");
  });
});
