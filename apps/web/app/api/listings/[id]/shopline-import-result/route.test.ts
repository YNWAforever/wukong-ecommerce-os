import { describe, expect, it } from "vitest";

import { createImportResultHandler } from "./route.js";

const listingId = "11111111-1111-4111-8111-111111111111";
const exportAttemptId = "22222222-2222-4222-8222-222222222222";

function makeHandler(
  overrides: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    listingExists?: boolean;
    exportAttemptExists?: boolean;
  } = {},
) {
  const role = overrides.role ?? "operator";
  const listingExists = overrides.listingExists ?? true;
  const exportAttemptExists = overrides.exportAttemptExists ?? true;

  const auditEvents: unknown[] = [];
  const created: unknown[] = [];

  const repositories = {
    listings: {
      async getById(id: string) {
        return listingExists ? { id } : null;
      },
    },
    exportAttempts: {
      async getById(id: string) {
        return exportAttemptExists ? { id } : null;
      },
    },
    importResults: {
      async create(input: unknown) {
        const row = {
          id: "created_1",
          createdAt: new Date("2026-09-03T00:00:00.000Z"),
          ...(input as Record<string, unknown>),
        };
        created.push(row);
        return row;
      },
    },
    audit: {
      async write(event: unknown) {
        auditEvents.push(event);
      },
    },
  };

  const deps = {
    sessionContext: {
      async resolve() {
        return {
          workspaceId: "ws_1",
          actorId: "user_1",
          role,
        };
      },
    },
    getDatabase: () => ({
      async forWorkspace(
        _workspaceId: string,
        work: (repos: unknown) => unknown,
      ) {
        return work(repositories);
      },
    }),
  };

  return {
    handler: createImportResultHandler(deps as never),
    auditEvents,
    created,
  };
}

function makeRequest(body: unknown) {
  return new Request(
    "http://localhost/api/listings/x/shopline-import-result",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/listings/[id]/shopline-import-result", () => {
  it("records an accepted outcome and writes an audit event", async () => {
    const { handler, auditEvents, created } = makeHandler();
    const response = await handler(
      makeRequest({ outcome: "accepted" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.outcome).toBe("accepted");
    expect(created).toHaveLength(1);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "listing.shopline_import_result_recorded",
        entityId: listingId,
        metadata: expect.objectContaining({ outcome: "accepted" }),
      }),
    ]);
  });

  it("records a rejected outcome with a reason", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      makeRequest({ outcome: "rejected", rejectReason: "duplicate SKU" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.outcome).toBe("rejected");
  });

  it("records an outcome against a specific exportAttemptId", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      makeRequest({ outcome: "accepted", exportAttemptId }),
      makeContext(listingId),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.exportAttemptId).toBe(exportAttemptId);
  });

  it("rejects a rejected outcome with no rejectReason as a 400", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      makeRequest({ outcome: "rejected" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown listing", async () => {
    const { handler } = makeHandler({ listingExists: false });
    const response = await handler(
      makeRequest({ outcome: "accepted" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("listing_not_found");
  });

  it("returns 404 for an exportAttemptId not found in this workspace", async () => {
    const { handler } = makeHandler({ exportAttemptExists: false });
    const response = await handler(
      makeRequest({ outcome: "accepted", exportAttemptId }),
      makeContext(listingId),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("export_attempt_not_found");
  });

  it("returns 403 for a viewer role", async () => {
    const { handler } = makeHandler({ role: "viewer" });
    const response = await handler(
      makeRequest({ outcome: "accepted" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(403);
  });
});
