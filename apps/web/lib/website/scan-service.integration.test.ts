import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { createDatabase } from "@wukong/db";
import { createWebsiteDocumentHandler } from "../../app/api/internal/website-document/route";
import { createPublicFetch } from "./public-fetch";
import { consumeWebsiteMessage } from "../../../worker/src/website-consumer";
import {
  WEBSITE_DOCUMENT_PATH,
  signQueueRequest,
  type WebsiteJob,
} from "@wukong/jobs";
const appUrl = process.env.TEST_DATABASE_URL,
  adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!appUrl || !adminUrl)
  throw new Error("Explicit synthetic TEST_DATABASE URLs required");
const database = createDatabase(appUrl, { migrationUrl: adminUrl });
const admin = postgres(adminUrl, {
  max: 1,
  prepare: false,
  onnotice: () => {},
});
const workspaceId = `website_orchestration_${randomUUID()}`,
  actorId = workspaceId + "_actor";
let instant = new Date();
const secret = "synthetic-website-callback-only";
const read = (id: string) =>
  database.forWorkspace(workspaceId, (r) => r.websiteCatalog.getScan(id));
const create = () =>
  database.forWorkspace(workspaceId, (r) =>
    r.websiteCatalog.createScan({
      url: "https://store.example/",
      requestedBy: actorId,
      requestKey: randomUUID(),
      now: instant,
    }),
  );
beforeAll(async () => {
  await database.migrate();
  await admin`insert into workspaces(id,name,profile) values (${workspaceId},'Synthetic orchestration','{}')`;
  await admin`insert into users(id,email) values (${actorId},${actorId + "@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values (${workspaceId},${actorId},'operator')`;
});
afterAll(async () => {
  await database.close();
  await admin.end();
});
const workerDb = () => ({
  forWorkspace: database.forWorkspace.bind(database),
  close: async () => {},
});
const jobFor = (scan: { id: string; revision: number }): WebsiteJob => ({
  kind: "website_scan",
  workspaceId,
  scanId: scan.id,
  revision: scan.revision,
});
async function signed(body: unknown) {
  const text = JSON.stringify(body),
    timestamp = Math.floor(instant.getTime() / 1000);
  return new Request("https://app.example" + WEBSITE_DOCUMENT_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wukong-timestamp": String(timestamp),
      "x-wukong-signature": await signQueueRequest({
        secret,
        timestamp,
        path: WEBSITE_DOCUMENT_PATH,
        body: text,
      }),
    },
    body: text,
  });
}
describe("real database signed website orchestration", () => {
  it("reapproves canonical origin before the first new-host page and saves immutable preview", async () => {
    const calls: string[] = [];
    const publicFetch = createPublicFetch({
      now: () => instant,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (target) => {
        calls.push(target.hostname + target.path);
        if (target.path === "/robots.txt")
          return {
            status: 200,
            contentType: "text/plain",
            body: ["User-agent: *\nDisallow: /private"],
          };
        if (target.hostname === "store.example")
          return {
            status: 301,
            contentType: "text/html",
            location: "https://www.store.example/",
            body: [],
          };
        if (target.path === "/")
          return {
            status: 200,
            contentType: "text/html",
            body: [
              '<a href="/products/one">One</a><a href="/private/two">Private</a>',
            ],
          };
        return {
          status: 200,
          contentType: "text/html",
          body: [
            '<script type="application/ld+json">{"@type":"Product","name":"Synthetic one"}</script>',
          ],
        };
      },
    });
    const route = createWebsiteDocumentHandler({
      secret: () => secret,
      now: () => instant,
      getDatabase: () => database,
      publicFetch,
    });
    const scan = await create();
    const queued: WebsiteJob[] = [jobFor(scan)];
    const env: any = {
      WEBSITE_FETCH_BASE_URL: "https://app.example",
      QUEUE_INGRESS_SECRET: secret,
      LISTING_QUEUE: {
        send: async (job: WebsiteJob) => {
          queued.push(job);
        },
      },
    };
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      route(new Request(url, init)),
    );
    while (queued.length) {
      const job = queued.shift()!;
      const row = (await read(scan.id))!;
      instant = new Date(
        Math.max(instant.getTime(), row.nextEligibleAt.getTime()),
      );
      expect(
        await consumeWebsiteMessage(job, env, {
          createDatabase: workerDb,
          fetch,
          now: () => instant,
        }),
      ).toBe("ack");
    }
    const final = (await read(scan.id))!;
    expect(final.state).toBe("ready");
    expect(final.checkpoint.preview.products).toHaveLength(1);
    expect(calls).toEqual([
      "store.example/robots.txt",
      "store.example/",
      "www.store.example/robots.txt",
      "www.store.example/",
      "www.store.example/products/one",
    ]);
    const saved = await database.forWorkspace(workspaceId, (r) =>
      r.websiteCatalog.saveSelection({
        scanId: scan.id,
        keys: final.checkpoint.preview.products.map((p) => p.key),
        actorId,
      }),
    );
    expect(saved.savedIds).toHaveLength(1);
    const before = calls.length;
    expect(
      await consumeWebsiteMessage(jobFor(scan), env, {
        createDatabase: workerDb,
        fetch,
        now: () => instant,
      }),
    ).toBe("ack");
    expect(calls).toHaveLength(before);
  });
  it("fences simultaneous callbacks and replays the completed lease without a second fetch", async () => {
    const scan = await create();
    const step = (await database.forWorkspace(workspaceId, (r) =>
      r.websiteCatalog.claimStep({
        scanId: scan.id,
        revision: 0,
        now: instant,
      }),
    ))!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const fetching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const publicFetch = vi.fn(async () => {
      entered();
      await gate;
      return {
        url: "https://store.example/robots.txt",
        status: 404,
        contentType: "text/plain",
        text: "",
        capturedAt: instant.toISOString(),
        retryAfterSeconds: null,
      };
    });
    const route = createWebsiteDocumentHandler({
      secret: () => secret,
      now: () => instant,
      getDatabase: () => database,
      publicFetch,
    });
    const body = { ...jobFor(scan), leaseToken: step.leaseToken };
    const first = route(await signed(body));
    await fetching;
    const duplicate = await route(await signed(body));
    expect(duplicate.status).toBe(202);
    release();
    expect((await first).status).toBe(200);
    expect((await route(await signed(body))).status).toBe(200);
    expect(publicFetch).toHaveBeenCalledOnce();
  });
  it("exhausts three expired callback leases and retains a terminal failed scan", async () => {
    const scan = await create();
    const env: any = {
      WEBSITE_FETCH_BASE_URL: "https://app.example",
      QUEUE_INGRESS_SECRET: secret,
      LISTING_QUEUE: { send: vi.fn() },
    };
    const fetch = vi.fn(async () => {
      throw new Error("synthetic crash");
    });
    for (let i = 0; i < 3; i++) {
      expect(
        await consumeWebsiteMessage(jobFor(scan), env, {
          createDatabase: workerDb,
          fetch,
          now: () => instant,
        }),
      ).toEqual({ retryAfterSeconds: 60 });
      instant = new Date(instant.getTime() + 61000);
    }
    expect(
      await consumeWebsiteMessage(jobFor(scan), env, {
        createDatabase: workerDb,
        fetch,
        now: () => instant,
      }),
    ).toBe("ack");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await read(scan.id))?.state).toBe("failed");
    expect((await read(scan.id))?.checkpoint.preview.warnings).toContain(
      "step_attempts_exhausted",
    );
  });
});

async function runReviewedFixture(
  seedUrl: string,
  documents: Record<string, string | { redirect: string }>,
) {
  const requests: string[] = [];
  const publicFetch = createPublicFetch({
    now: () => instant,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (target) => {
      const url = `https://${target.hostname}${target.path}`;
      requests.push(url);
      if (target.path === "/robots.txt")
        return {
          status: 200,
          contentType: "text/plain",
          body: ["User-agent: *\nDisallow: /private"],
        };
      const value = documents[url];
      return typeof value === "string"
        ? { status: 200, contentType: "text/html", body: [value] }
        : value
          ? {
              status: 301,
              contentType: "text/html",
              location: value.redirect,
              body: [],
            }
          : { status: 404, contentType: "text/html", body: [] };
    },
  });
  const handler = createWebsiteDocumentHandler({
    secret: () => secret,
    now: () => instant,
    getDatabase: () => database,
    publicFetch,
  });
  const scan = await database.forWorkspace(workspaceId, (r) =>
    r.websiteCatalog.createScan({
      url: seedUrl,
      requestedBy: actorId,
      requestKey: randomUUID(),
      now: instant,
    }),
  );
  const queued: WebsiteJob[] = [jobFor(scan)];
  const env: any = {
    WEBSITE_FETCH_BASE_URL: "https://app.example",
    QUEUE_INGRESS_SECRET: secret,
    LISTING_QUEUE: {
      send: async (job: WebsiteJob) => {
        queued.push(job);
      },
    },
  };
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(url, init));
  for (let steps = 0; queued.length && steps < 32; steps++) {
    const job = queued.shift()!,
      row = (await read(scan.id))!;
    instant = new Date(
      Math.max(instant.getTime(), row.nextEligibleAt.getTime()),
    );
    expect(
      await consumeWebsiteMessage(job, env, {
        createDatabase: workerDb,
        fetch,
        now: () => instant,
      }),
    ).toBe("ack");
  }
  expect(queued).toHaveLength(0);
  return { scan: (await read(scan.id))!, requests };
}
it("persists the full changed path and query across real DB robots reapproval", async () => {
  const target = "https://www.store.example/new?colour=red";
  const result = await runReviewedFixture("https://store.example/old", {
    "https://store.example/old": { redirect: target },
    [target]:
      '<script type="application/ld+json">{"@type":"Product","name":"Changed path"}</script>',
  });
  expect(result.scan.state).toBe("ready");
  expect(result.scan.checkpoint.preview.products[0]?.sourceUrl).toBe(target);
  expect(result.requests).toEqual([
    "https://store.example/robots.txt",
    "https://store.example/old",
    "https://www.store.example/robots.txt",
    target,
    target,
  ]);
});
it("commits only actual fetched canonical product identity in the real DB", async () => {
  const product =
    '<link rel="canonical" href="/products/one"><script type="application/ld+json">{"@type":"Product","name":"Canonical one"}</script>';
  const result = await runReviewedFixture("https://store.example/", {
    "https://store.example/": '<a href="/products/one?ref=x">One</a>',
    "https://store.example/products/one?ref=x": product,
    "https://store.example/products/one": product,
  });
  expect(result.scan.state).toBe("ready");
  expect(result.scan.checkpoint.preview.products).toHaveLength(1);
  expect(result.scan.checkpoint.preview.products[0]?.sourceUrl).toBe(
    "https://store.example/products/one",
  );
  expect(result.requests).toEqual([
    "https://store.example/robots.txt",
    "https://store.example/",
    "https://store.example/products/one?ref=x",
    "https://store.example/products/one",
  ]);
  expect(result.scan.productRequests).toBe(2);
});
