import { describe, it, expect, vi } from "vitest";
import { consumeWebsiteMessage } from "./website-consumer.js";
import { verifyQueueRequest, WEBSITE_DOCUMENT_PATH } from "@wukong/jobs";
const job = {
  kind: "website_scan" as const,
  workspaceId: "ws",
  scanId: "10000000-0000-4000-8000-000000000001",
  revision: 0,
};
const now = new Date("2026-09-06T00:00:00Z");
function setup() {
  let row: any = {
    ...job,
    id: job.scanId,
    state: "running",
    nextEligibleAt: now,
    deadlineAt: new Date(now.getTime() + 900000),
    leaseExpiresAt: null,
  };
  const recordDispatch = vi.fn();
  const claimStep = vi.fn(async () => ({ leaseToken: job.scanId }));
  const database = {
    forWorkspace: async (ws: string, work: any) => {
      expect(ws).toBe("ws");
      return work({
        websiteCatalog: { getScan: async () => row, claimStep, recordDispatch },
      });
    },
    close: vi.fn(),
  };
  const send = vi.fn();
  const env: any = {
    WEBSITE_FETCH_BASE_URL: "https://app.example",
    QUEUE_INGRESS_SECRET: "synthetic-internal-secret",
    LISTING_QUEUE: { send },
  };
  const fetch = vi.fn(async () => {
    row = {
      ...row,
      revision: 1,
      nextEligibleAt: new Date(now.getTime() + 1000),
    };
    return Response.json({ status: "completed" });
  });
  const deps = {
    createDatabase: () => database as any,
    fetch: fetch as any,
    now: () => now,
  };
  return {
    deps,
    env,
    fetch,
    database,
    recordDispatch,
    claimStep,
    send,
    setRow: (change: any) => {
      row = { ...row, ...change };
    },
  };
}
describe("website queue consumer", () => {
  it("calls only configured signed Node callback then enqueues committed revision", async () => {
    const s = setup();
    expect(await consumeWebsiteMessage(job, s.env, s.deps)).toBe("ack");
    const [url, init] = s.fetch.mock.calls[0] as any;
    expect(String(url)).toBe("https://app.example" + WEBSITE_DOCUMENT_PATH);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({ ...job, leaseToken: job.scanId });
    expect(
      await verifyQueueRequest({
        secret: s.env.QUEUE_INGRESS_SECRET,
        nowSeconds: now.getTime() / 1000,
        timestamp: init.headers["x-wukong-timestamp"],
        signature: init.headers["x-wukong-signature"],
        path: WEBSITE_DOCUMENT_PATH,
        body: init.body,
      }),
    ).toBe(true);
    expect(s.send).toHaveBeenCalledWith(
      { ...job, revision: 1 },
      { delaySeconds: 1 },
    );
    expect(s.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1, status: "sent" }),
    );
    expect(s.database.close).toHaveBeenCalledOnce();
  });
  it("acknowledges duplicate delivery without callback", async () => {
    const s = setup();
    s.setRow({ revision: 1 });
    expect(await consumeWebsiteMessage(job, s.env, s.deps)).toBe("ack");
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it("delays future eligibility without consuming a lease", async () => {
    const s = setup();
    s.setRow({ nextEligibleAt: new Date(now.getTime() + 5000) });
    expect(await consumeWebsiteMessage(job, s.env, s.deps)).toEqual({
      retryAfterSeconds: 5,
    });
    expect(s.claimStep).not.toHaveBeenCalled();
  });
  it("waits for an active lease", async () => {
    const s = setup();
    s.setRow({ leaseExpiresAt: new Date(now.getTime() + 60000) });
    expect(await consumeWebsiteMessage(job, s.env, s.deps)).toEqual({
      retryAfterSeconds: 60,
    });
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it("lets the repository terminate exhausted attempts or deadline", async () => {
    const s = setup();
    s.claimStep.mockResolvedValue(null as any);
    expect(await consumeWebsiteMessage(job, s.env, s.deps)).toBe("ack");
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it("leaves failed next enqueue recoverable", async () => {
    const s = setup();
    s.send.mockRejectedValue(new Error("send failed"));
    expect(await consumeWebsiteMessage(job, s.env, s.deps)).toBe("ack");
    expect(s.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", revision: 1 }),
    );
  });
  it("retries callback failure after lease expiry without trusting response contents", async () => {
    const s = setup();
    s.fetch.mockRejectedValue(new Error("network secret"));
    expect(await consumeWebsiteMessage(job, s.env, s.deps)).toEqual({
      retryAfterSeconds: 60,
    });
  });
  it("rejects malformed website payload before creating runtime", async () => {
    const s = setup();
    expect(
      await consumeWebsiteMessage(
        { ...job, url: "https://private/" },
        s.env,
        s.deps,
      ),
    ).toBe("ack");
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.database.close).not.toHaveBeenCalled();
  });
  it("reports missing callback configuration without invoking AI or SHOPLINE", async () => {
    const s = setup();
    delete s.env.WEBSITE_FETCH_BASE_URL;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await consumeWebsiteMessage(job, s.env, s.deps)).toEqual({
      retryAfterSeconds: 60,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("WEBSITE_FETCH_BASE_URL"),
    );
    expect(s.fetch).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

it("terminates the durable deadline even when callback configuration is absent", async () => {
  const s = setup();
  delete s.env.WEBSITE_FETCH_BASE_URL;
  s.setRow({ deadlineAt: new Date(now.getTime() - 1) });
  s.claimStep.mockResolvedValue(null as any);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await consumeWebsiteMessage(job, s.env, s.deps)).toBe("ack");
  expect(s.claimStep).toHaveBeenCalledOnce();
  log.mockRestore();
});

it("schedules the deadline before a crawl delay extending past it", async () => {
  const s = setup();
  s.setRow({ nextEligibleAt: new Date(now.getTime() + 86400000) });
  expect(await consumeWebsiteMessage(job, s.env, s.deps)).toEqual({
    retryAfterSeconds: 900,
  });
});
