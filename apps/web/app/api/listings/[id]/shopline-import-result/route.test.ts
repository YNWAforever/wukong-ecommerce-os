import { describe, expect, it } from "vitest";
import { createImportResultHandler } from "./route.js";
const listingId = "11111111-1111-4111-8111-111111111111";
const exportAttemptId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
function fixture(overrides: Record<string, unknown> = {}) {
  const created: unknown[] = [];
  const audit: unknown[] = [];
  const handler = createImportResultHandler({
    sessionContext: {
      resolve: async () => ({
        workspaceId: "ws",
        actorId: "user",
        role: "operator",
      }),
    },
    getDatabase: () => ({
      forWorkspace: async (_ws: string, work: any) =>
        work({
          listings: { getById: async () => ({ id: listingId }) },
          exportAttempts: {
            getById: async () => ({
              id: exportAttemptId,
              artifactStatus: "ready",
              artifactSha256: "a".repeat(64),
              provenance: { identityVersion: 1 },
              manifest: [],
              ...overrides,
            }),
          },
          importResults: {
            create: async (input: any) => {
              created.push(input);
              return {
                ...input,
                id: "receipt",
                createdAt: new Date(),
                wasCreated: true,
              };
            },
          },
          audit: {
            write: async (input: any) => {
              audit.push(input);
            },
          },
        }),
    }),
  } as never);
  return { handler, created, audit };
}
const request = (body: unknown) =>
  new Request("http://localhost/result", {
    method: "POST",
    body: JSON.stringify(body),
  });
const context = { params: Promise.resolve({ id: listingId }) };
describe("trusted result recording boundary", () => {
  it("rejects the legacy export request missing explicit mode, version and idempotency key", async () => {
    const { handler, created } = fixture();
    const response = await handler(
      request({ outcome: "accepted", exportAttemptId }),
      context,
    );
    expect(response.status).toBe(400);
    expect(created).toHaveLength(0);
  });
  it("requires explicit mode rather than interpreting old requests as trusted", async () => {
    const { handler } = fixture();
    expect(
      (await handler(request({ outcome: "accepted" }), context)).status,
    ).toBe(400);
  });
  it.each(["versionId", "idempotencyKey"])(
    "requires %s for linked reporting",
    async (field) => {
      const { handler } = fixture();
      const body: any = {
        mode: "export",
        outcome: "accepted",
        exportAttemptId,
        versionId,
        idempotencyKey: "key",
      };
      delete body[field];
      expect((await handler(request(body), context)).status).toBe(400);
    },
  );
});
import { ImportResultConflict } from "@wukong/db";
import { vi } from "vitest";
const exportBody = {
  mode: "export",
  exportAttemptId,
  versionId,
  idempotencyKey: "client-retry",
  outcome: "accepted",
};
function recordingFixture(
  options: {
    role?: "viewer" | "operator" | "reviewer";
    replayed?: boolean;
    error?: ImportResultConflict;
  } = {},
) {
  const create = vi.fn(async (input: unknown) => {
    if (options.error) throw options.error;
    return {
      id: "receipt",
      ...(input as object),
      createdAt: new Date(),
      wasCreated: !options.replayed,
    };
  });
  const write = vi.fn();
  const handler = createImportResultHandler({
    sessionContext: {
      resolve: async () => ({
        workspaceId: "server-ws",
        actorId: "actor",
        role: options.role ?? "operator",
      }),
    },
    getDatabase: () => ({
      forWorkspace: async (_ws: string, work: any) =>
        work({ importResults: { create }, audit: { write } }),
    }),
  } as never);
  return { handler, create, write };
}
it("records one operator receipt and audits exact export context", async () => {
  const { handler, create, write } = recordingFixture();
  const response = await handler(request(exportBody), context);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    result: { mode: "export", versionId, exportAttemptId },
    replayed: false,
  });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ recordedBy: "actor", listingId, versionId }),
  );
  expect(write).toHaveBeenCalledOnce();
});
it("returns exact retries without duplicate audit", async () => {
  const { handler, write } = recordingFixture({ replayed: true });
  const response = await handler(request(exportBody), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ replayed: true });
  expect(write).not.toHaveBeenCalled();
});
it.each([
  "listing_not_in_export",
  "export_version_mismatch",
  "stale_import_result",
  "idempotency_conflict",
])("maps repository %s rejection and writes no audit", async (code) => {
  const { handler, write } = recordingFixture({
    error: new ImportResultConflict(code),
  });
  const response = await handler(request(exportBody), context);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code });
  expect(write).not.toHaveBeenCalled();
});
it("keeps foreign attempts inaccessible", async () => {
  const { handler } = recordingFixture({
    error: new ImportResultConflict("export_attempt_not_found", 404),
  });
  expect((await handler(request(exportBody), context)).status).toBe(404);
});
it("rejects viewers before recording", async () => {
  const { handler, create } = recordingFixture({ role: "viewer" });
  expect((await handler(request(exportBody), context)).status).toBe(403);
  expect(create).not.toHaveBeenCalled();
});
it("requires a rejection reason and matching correction context", async () => {
  const { handler, create } = recordingFixture();
  expect(
    (await handler(request({ ...exportBody, outcome: "rejected" }), context))
      .status,
  ).toBe(400);
  expect(
    (
      await handler(
        request({ ...exportBody, supersedesResultId: versionId }),
        context,
      )
    ).status,
  ).toBe(400);
  expect(create).not.toHaveBeenCalled();
});
it("accepts explicit unlinked historical mode and prevents export fields there", async () => {
  const { handler, create } = recordingFixture();
  expect(
    (
      await handler(
        request({ ...exportBody, mode: "historical_manual" }),
        context,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handler(
        request({
          mode: "historical_manual",
          outcome: "accepted",
          idempotencyKey: "manual",
        }),
        context,
      )
    ).status,
  ).toBe(201);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "historical_manual",
      exportAttemptId: null,
      versionId: null,
    }),
  );
});
it("rejects unauthenticated sessions before opening storage", async () => {
  const handler = createImportResultHandler({
    sessionContext: { resolve: async () => null },
    getDatabase: () => {
      throw new Error("must not open");
    },
  });
  expect((await handler(request(exportBody), context)).status).toBe(401);
});
