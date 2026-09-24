import type { WorkbenchPage, WorkbenchQuery } from "@wukong/db";
import { describe, expect, it, vi } from "vitest";

import type { SessionContext } from "../../../lib/session-context-port";
import { createWorkbenchHandler } from "./route.js";

const page: WorkbenchPage = {
  items: [],
  counts: { attention: 3, progress: 2, completed: 1, unclassified: 0 },
  totalMatching: 3,
  observedAt: "2026-09-06T00:00:00.000Z",
  page: 1,
  pageSize: 25,
};

function request(query = ""): Request {
  return new Request(
    `http://localhost/api/workbench${query ? `?${query}` : ""}`,
  );
}

function makeHandler(context: SessionContext | null) {
  const pageCall = vi.fn(async (_query: WorkbenchQuery) => page);
  const forWorkspace = vi.fn(
    async <T>(
      _workspaceId: string,
      work: (repositories: {
        workbench: { page: typeof pageCall };
      }) => Promise<T>,
    ) => work({ workbench: { page: pageCall } }),
  );
  const handler = createWorkbenchHandler({
    sessionContext: { resolve: async () => context },
    getDatabase: () => ({ forWorkspace }) as never,
  });
  return { handler, forWorkspace, pageCall };
}

describe("GET /api/workbench", () => {
  it("requires an authenticated workspace session", async () => {
    const { handler, forWorkspace } = makeHandler(null);

    const response = await handler(request());

    expect(response.status).toBe(401);
    expect(forWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    "state=bogus",
    "kind=bogus",
    "page=0",
    "page=21474837",
    "page=1.5",
    "pageSize=0",
    "pageSize=101",
    "pageSize=1.5",
  ])("rejects invalid query parameters: %s", async (query) => {
    const { handler, forWorkspace } = makeHandler({
      workspaceId: "workspace-session",
      actorId: "viewer-1",
      role: "viewer",
    });

    const response = await handler(request(query));

    expect(response.status).toBe(400);
    expect(forWorkspace).not.toHaveBeenCalled();
  });

  it("uses defaults and the authenticated workspace regardless of query workspaceId", async () => {
    const { handler, forWorkspace, pageCall } = makeHandler({
      workspaceId: "workspace-session",
      actorId: "viewer-1",
      role: "viewer",
    });

    const response = await handler(
      request("workspaceId=workspace-other&unknown=value"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(forWorkspace).toHaveBeenCalledOnce();
    expect(forWorkspace).toHaveBeenCalledWith(
      "workspace-session",
      expect.any(Function),
    );
    expect(pageCall).toHaveBeenCalledWith({
      state: "attention",
      page: 1,
      pageSize: 25,
    });
    expect(body).toEqual({
      ...page,
      capabilities: {
        canImport: false,
        canReview: false,
        canRecordImportResult: false,
      },
    });
  });

  it("passes exact filters and exposes reviewer capabilities", async () => {
    const { handler, pageCall } = makeHandler({
      workspaceId: "workspace-session",
      actorId: "reviewer-1",
      role: "reviewer",
    });

    const response = await handler(
      request("state=completed&kind=export&page=2&pageSize=100"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(pageCall).toHaveBeenCalledWith({
      state: "completed",
      kind: "export",
      page: 2,
      pageSize: 100,
    });
    expect(body.capabilities).toEqual({
      canImport: true,
      canReview: true,
      canRecordImportResult: true,
    });
  });
});
