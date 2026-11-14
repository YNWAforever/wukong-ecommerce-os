import { describe, expect, it, vi } from "vitest";
import type { WebsiteScan } from "@wukong/db";
import { websiteDispatchRecoveryState } from "@wukong/core";
import { QueueIngressError } from "../../../../../lib/cloudflare-queue-runtime";
import { createWebsiteScanRetryHandler } from "./route";
const id = "10000000-0000-4000-8000-000000000001";
const clock = new Date("2026-11-15T00:00:01Z");
function fixtureScan(): WebsiteScan {
  const start = new Date(clock.getTime() - 1000),
    deadline = new Date(clock.getTime() + 900_000);
  return {
    id,
    workspaceId: "own",
    requestedBy: "creator",
    requestKey: "private-key",
    requestedUrl: "https://store.example/",
    state: "queued",
    revision: 0,
    attempts: 0,
    discoveryRequests: 0,
    productRequests: 0,
    robotsRequests: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    nextEligibleAt: start,
    deadlineAt: deadline,
    dispatchStatus: "failed",
    dispatchAttempts: 1,
    dispatchAt: start,
    createdAt: start,
    updatedAt: start,
    checkpoint: {
      seedUrl: "https://store.example/",
      canonicalOrigin: null,
      robotsPolicy: null,
      pending: { url: "https://store.example/robots.txt", kind: "robots" },
      discoveryUrls: [],
      candidateUrls: [],
      visitedUrls: [],
      nextEligibleAt: start.toISOString(),
      deadlineAt: deadline.toISOString(),
      preview: { products: [], warnings: [] },
    },
  };
}
function harness(
  role:
    "operator" | "reviewer" | "admin" | "owner" | "viewer" | null = "operator",
) {
  let scan: WebsiteScan | null = fixtureScan();
  const enqueue = vi.fn(async (_job: unknown): Promise<void> => {});
  const claimDispatch = vi.fn(
    async (input: {
      revision: number;
      expectedAttempts: number;
      now: Date;
      actorId: string;
    }) => {
      if (
        !scan ||
        scan.revision !== input.revision ||
        scan.dispatchAttempts !== input.expectedAttempts ||
        websiteDispatchRecoveryState(scan, input.now) !== "retryable"
      )
        return null;
      scan = {
        ...scan,
        dispatchAttempts: scan.dispatchAttempts + 1,
        dispatchStatus: "pending",
        dispatchAt: input.now,
      };
      return { ...scan };
    },
  );
  const recordDispatch = vi.fn(
    async (input: {
      revision: number;
      expectedAttempts: number;
      status: string;
    }) => {
      if (
        !scan ||
        scan.revision !== input.revision ||
        scan.dispatchAttempts !== input.expectedAttempts
      )
        return false;
      scan = { ...scan, dispatchStatus: input.status };
      return true;
    },
  );
  const getScan = vi.fn(async () => scan);
  const repository = {
    websiteCatalog: { getScan, claimDispatch, recordDispatch },
  };
  const forWorkspace = vi.fn(
    async <T>(
      workspace: string,
      work: (repos: typeof repository) => Promise<T>,
    ) => {
      expect(workspace).toBe("own");
      return work(repository);
    },
  );
  const handler = createWebsiteScanRetryHandler({
    session: {
      resolve: async () =>
        role ? { workspaceId: "own", actorId: "operator", role } : null,
    },
    getDatabase: () => ({ forWorkspace }) as never,
    enqueue,
    now: () => clock,
  });
  return {
    handler,
    enqueue,
    claimDispatch,
    recordDispatch,
    forWorkspace,
    getScan,
    get scan() {
      return scan;
    },
    set scan(value: WebsiteScan | null) {
      scan = value;
    },
  };
}
function request(body: unknown = { revision: 0, attempts: 1 }) {
  return new Request(`https://app.example/api/website-scans/${id}/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const context = () => ({ params: Promise.resolve({ id }) });
describe("explicit website delivery retry", () => {
  it("retries only the recorded job identity and returns persisted public state", async () => {
    const f = harness();
    const before = structuredClone(f.scan);
    const result = await f.handler(request(), context());
    expect(result.status).toBe(202);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({
      kind: "website_scan",
      workspaceId: "own",
      scanId: id,
      revision: 0,
    });
    expect(f.claimDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "operator", expectedAttempts: 1 }),
    );
    expect(f.scan).toMatchObject({
      id,
      dispatchAttempts: 2,
      dispatchStatus: "sent",
      requestKey: before!.requestKey,
      deadlineAt: before!.deadlineAt,
      checkpoint: before!.checkpoint,
    });
    const body = await result.json();
    expect(body.dispatch).toEqual({
      recoveryState: "waiting",
      revision: 0,
      attempts: 2,
    });
    for (const field of [
      "workspaceId",
      "requestKey",
      "leaseToken",
      "checkpoint",
    ])
      expect(body).not.toHaveProperty(field);
  });
  it("keeps a rejected delivery recoverable and never leaks exception details", async () => {
    const f = harness();
    f.enqueue.mockRejectedValue(new QueueIngressError("rejected"));
    const result = await f.handler(request(), context());
    expect(result.status).toBe(202);
    const body = await result.json();
    expect(body.id).toBe(id);
    expect(body.dispatch).toMatchObject({
      recoveryState: "retryable",
      attempts: 2,
    });
    expect(body.warnings).toContain("website_scan_unavailable");
    expect(JSON.stringify(body)).not.toContain("queue_unavailable");
  });
  it("never reports an old dispatch result over a progressed scan", async () => {
    const f = harness();
    f.enqueue.mockImplementation(async () => {
      f.scan = {
        ...f.scan!,
        state: "ready",
        revision: 1,
        dispatchStatus: "pending",
      };
    });
    const response = await f.handler(request(), context());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      state: "ready",
      dispatch: { revision: 1, recoveryState: "unavailable" },
    });
  });
  it("rejects stale replays before another enqueue", async () => {
    const f = harness();
    expect((await f.handler(request(), context())).status).toBe(202);
    expect((await f.handler(request(), context())).status).toBe(409);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it("allows only one concurrent delivery request", async () => {
    const f = harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.enqueue.mockImplementation(async () => held);
    const first = f.handler(request(), context());
    await vi.waitFor(() => expect(f.enqueue).toHaveBeenCalledTimes(1));
    expect((await f.handler(request(), context())).status).toBe(409);
    release();
    expect((await first).status).toBe(202);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it.each([null, "viewer"] as const)(
    "denies %s before accessing records",
    async (role) => {
      const f = harness(role);
      expect((await f.handler(request(), context())).status).toBe(
        role ? 403 : 401,
      );
      expect(f.forWorkspace).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );
  it("hides foreign or missing scans", async () => {
    const f = harness();
    f.scan = null;
    expect((await f.handler(request(), context())).status).toBe(404);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    { revision: 1, attempts: 1 },
    { revision: 0, attempts: 0 },
  ])("rejects a changed fence %j", async (body) => {
    const f = harness();
    expect((await f.handler(request(body), context())).status).toBe(409);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    { revision: 0, attempts: 1, workspaceId: "foreign" },
    { revision: 0, attempts: 1, url: "https://other.example/" },
    { revision: 0.5, attempts: 1 },
    { revision: 0, attempts: -1 },
  ])("rejects caller-controlled scope or invalid fence %j", async (body) => {
    const f = harness();
    expect((await f.handler(request(body), context())).status).toBe(400);
    expect(f.forWorkspace).not.toHaveBeenCalled();
  });
  it("does not redispatch an active document lease or expired scan", async () => {
    for (const patch of [
      { leaseExpiresAt: new Date(clock.getTime() + 1000) },
      { deadlineAt: clock },
    ]) {
      const f = harness();
      f.scan = { ...f.scan!, ...patch };
      expect((await f.handler(request(), context())).status).toBe(409);
      expect(f.enqueue).not.toHaveBeenCalled();
    }
  });
});
