import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../index.js";
import type { WebsiteCheckpoint, WebsiteStep } from "./website-catalog.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !appUrl)
  throw new Error(
    "Explicit TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL required",
  );
const admin = postgres(adminUrl, {
  max: 1,
  prepare: false,
  onnotice: () => {},
});
const db = createDatabase(appUrl, { migrationUrl: adminUrl });
const ws = `website_${randomUUID()}`,
  other = `website_other_${randomUUID()}`;
const now = new Date("2026-09-06T00:00:00Z");
const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const run = <T>(
  fn: (
    repo: Parameters<
      Parameters<typeof db.forWorkspace>[1]
    >[0]["websiteCatalog"],
  ) => Promise<T>,
  workspace = ws,
) => db.forWorkspace(workspace, (r) => fn(r.websiteCatalog));
const create = () =>
  run((r) =>
    r.createScan({
      url: "https://store.example/",
      requestedBy: ws + "op",
      requestKey: randomUUID(),
      now,
    }),
  );
const product = {
  key: "https://store.example/products/one",
  sourceUrl: "https://store.example/products/one",
  capturedAt: now.toISOString(),
  title: "Synthetic product",
  description: null,
  imageUrls: [],
  price: null,
  availability: "unknown" as const,
  attributes: {},
  fieldSources: {},
  warnings: [],
};
const ready = (checkpoint: WebsiteCheckpoint): WebsiteCheckpoint => ({
  ...checkpoint,
  canonicalOrigin: "https://store.example/",
  pending: null,
  preview: { products: [product], warnings: [] },
});

beforeAll(async () => {
  await db.migrate();
  await admin`insert into workspaces(id,name,profile) values (${ws},'Synthetic website','{}'),(${other},'Synthetic foreign','{}')`;
  await admin`insert into users(id,email) values (${ws + "op"},${ws + "@example.test"}),(${ws + "view"},${ws + "-view@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values (${ws},${ws + "op"},'operator'),(${ws},${ws + "view"},'viewer')`;
});
afterAll(async () => {
  await db.close();
  await admin.end();
});

describe("durable website catalog", () => {
  it("creates idempotently and isolates foreign workspace ids", async () => {
    const input = {
      url: "https://store.example/",
      requestedBy: ws + "op",
      requestKey: randomUUID(),
      now,
    };
    const a = await run((r) => r.createScan(input)),
      b = await run((r) => r.createScan(input));
    expect(a.id).toBe(b.id);
    expect(await run((r) => r.getScan(a.id), other)).toBeNull();
    expect(
      await run((r) => r.claimStep({ scanId: a.id, revision: 0, now }), other),
    ).toBeNull();
  });
  it("grants only one concurrent lease and only one concurrent document fetch", async () => {
    const scan = await create();
    const claims = await Promise.all(
      [0, 1].map(() =>
        run((r) => r.claimStep({ scanId: scan.id, revision: 0, now })),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const step = claims.find(Boolean)!;
    const fetches = await Promise.all(
      [0, 1].map(() => run((r) => r.beginDocumentFetch({ ...step, now }))),
    );
    expect(fetches.map((f) => f.status).sort()).toEqual([
      "claimed",
      "in_progress",
    ]);
  });
  it("fences expired leases and reclaims without exposing another result", async () => {
    const scan = await create();
    const a = (await run((r) =>
      r.claimStep({ scanId: scan.id, revision: 0, now }),
    ))!;
    await run((r) => r.beginDocumentFetch({ ...a, now }));
    const b = (await run((r) =>
      r.claimStep({ scanId: scan.id, revision: 0, now: at(61) }),
    ))!;
    expect(b.leaseToken).not.toBe(a.leaseToken);
    expect(
      (await run((r) => r.beginDocumentFetch({ ...a, now: at(61) }))).status,
    ).toBe("stale");
    await expect(
      run((r) =>
        r.completeStep({
          ...a,
          observation: {
            state: "failed",
            checkpoint: { ...scan.checkpoint, pending: null },
          },
          now: at(61),
        }),
      ),
    ).rejects.toThrow("stale");
  });
  it("replays a completed matching lease without fetching and freezes terminal previews", async () => {
    const scan = await create();
    const step = (await run((r) =>
      r.claimStep({ scanId: scan.id, revision: 0, now }),
    ))!;
    await run((r) => r.beginDocumentFetch({ ...step, now }));
    const observation = {
      state: "failed" as const,
      checkpoint: { ...scan.checkpoint, pending: null },
    };
    const finished = await run((r) =>
      r.completeStep({ ...step, observation, now: at(1) }),
    );
    expect(finished.state).toBe("failed");
    expect(
      (await run((r) => r.beginDocumentFetch({ ...step, now: at(120) })))
        .status,
    ).toBe("completed");
    expect(
      (
        await run((r) =>
          r.beginDocumentFetch({
            ...step,
            leaseToken: randomUUID(),
            now: at(120),
          }),
        )
      ).status,
    ).toBe("stale");
    expect(
      (await run((r) => r.completeStep({ ...step, observation, now: at(120) })))
        .revision,
    ).toBe(1);
    const rows =
      await admin`select action from audit_events where workspace_id=${ws} and entity_id=${scan.id}`;
    expect(
      rows.filter((r) => r.action === "website.scan_finished"),
    ).toHaveLength(1);
  });
  it("terminates after three exhausted leases and bounds recovery dispatch", async () => {
    const scan = await create();
    for (const s of [0, 61, 122]) {
      const step = await run((r) =>
        r.claimStep({ scanId: scan.id, revision: 0, now: at(s) }),
      );
      expect(step).not.toBeNull();
    }
    expect(
      await run((r) =>
        r.claimStep({ scanId: scan.id, revision: 0, now: at(183) }),
      ),
    ).toBeNull();
    expect((await run((r) => r.getScan(scan.id)))?.state).toBe("failed");
    const second = await create();
    expect(
      await run((r) =>
        r.recordDispatch({
          scanId: second.id,
          revision: 99,
          status: "sent",
          now,
        }),
      ),
    ).toBe(false);
    expect(
      await run((r) =>
        r.recordDispatch({
          scanId: second.id,
          revision: 0,
          status: "failed",
          now,
        }),
      ),
    ).toBe(true);
    expect(
      (await run((r) => r.listDispatchable({ now: at(61), limit: 100 }))).some(
        (s) => s.id === second.id,
      ),
    ).toBe(true);
  });
  it("rejects invalid checkpoints including full metadata above one MiB", async () => {
    const scan = await create(),
      step = (await run((r) =>
        r.claimStep({ scanId: scan.id, revision: 0, now }),
      ))!;
    await run((r) => r.beginDocumentFetch({ ...step, now }));
    const bad = {
      ...scan.checkpoint,
      pending: null,
      robotsPolicy: {
        origin: "https://store.example/",
        state: "ready",
        directives: Array.from({ length: 300 }, () => ({
          field: "allow",
          value: "a".repeat(4096),
        })),
        sitemapLinks: [],
        crawlDelaySeconds: 1,
        warnings: [],
      },
    };
    await expect(
      run((r) =>
        r.completeStep({
          ...step,
          observation: {
            state: "failed",
            checkpoint: bad as WebsiteCheckpoint,
          },
          now: at(1),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      run((r) =>
        r.completeStep({
          ...step,
          observation: { state: "ready", checkpoint: ready(scan.checkpoint) },
          now: at(1),
        }),
      ),
    ).rejects.toThrow();
  });
  it("saves server preview exactly once across concurrent saves and rejects invalid keys", async () => {
    const scan = await create();
    // Exercise the public progression: robots -> discovery -> product -> ready.
    let checkpoint: WebsiteCheckpoint = {
      ...scan.checkpoint,
      robotsPolicy: {
        origin: "https://store.example/",
        state: "ready",
        directives: [],
        sitemapLinks: [],
        crawlDelaySeconds: 1,
        warnings: [],
      },
      pending: { kind: "discovery", url: "https://store.example/" },
      nextEligibleAt: at(1).toISOString(),
    };
    for (const [revision, kind] of [
      [0, "robots"],
      [1, "discovery"],
      [2, "product"],
    ] as const) {
      const step = (await run((r) =>
        r.claimStep({ scanId: scan.id, revision, now: at(revision) }),
      ))!;
      expect(step.kind).toBe(kind);
      await run((r) => r.beginDocumentFetch({ ...step, now: at(revision) }));
      if (revision === 1)
        checkpoint = {
          ...checkpoint,
          canonicalOrigin: "https://store.example/",
          pending: { kind: "product", url: product.sourceUrl },
          candidateUrls: [product.sourceUrl],
          nextEligibleAt: at(2).toISOString(),
        };
      if (revision === 2) checkpoint = ready(checkpoint);
      await run((r) =>
        r.completeStep({
          ...step,
          observation: {
            state: revision === 2 ? "ready" : "running",
            checkpoint,
          },
          now: at(revision),
        }),
      );
    }
    const saved = await Promise.all(
      [0, 1].map(() =>
        run((r) =>
          r.saveSelection({
            scanId: scan.id,
            keys: [product.key],
            actorId: ws + "op",
          }),
        ),
      ),
    );
    expect(saved.flatMap((s) => s.savedIds)).toHaveLength(1);
    expect(saved.flatMap((s) => s.alreadySavedIds)).toEqual(
      saved.flatMap((s) => s.savedIds),
    );
    for (const keys of [
      [],
      [product.key, product.key],
      ["https://store.example/unknown"],
    ])
      await expect(
        run((r) =>
          r.saveSelection({ scanId: scan.id, keys, actorId: ws + "op" }),
        ),
      ).rejects.toThrow();
    await expect(
      run((r) =>
        r.saveSelection({
          scanId: scan.id,
          keys: [product.key],
          actorId: ws + "view",
        }),
      ),
    ).rejects.toThrow("operator");
    await expect(
      run(
        (r) =>
          r.saveSelection({
            scanId: scan.id,
            keys: [product.key],
            actorId: ws + "op",
          }),
        other,
      ),
    ).rejects.toThrow();
    const products = await run((r) => r.listProducts());
    expect(products[0]?.observation).toEqual(product);
    expect(await run((r) => r.listProducts(), other)).toEqual([]);
  });
});

it("supports initial robots canonicalization and same-origin product redirects", async () => {
  const scan = await create(),
    alias = "https://www.store.example/";
  let step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 0, now }),
  ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now }));
  let checkpoint: WebsiteCheckpoint = {
    ...scan.checkpoint,
    canonicalOrigin: alias,
    robotsPolicy: {
      origin: alias,
      state: "ready",
      directives: [],
      sitemapLinks: [],
      crawlDelaySeconds: 1,
      warnings: [],
    },
    pending: { kind: "product", url: alias + "products/old" },
    candidateUrls: [alias + "products/old"],
    nextEligibleAt: at(1).toISOString(),
  };
  await run((r) =>
    r.completeStep({
      ...step,
      now,
      observation: {
        documentUrl: alias + "robots.txt",
        state: "running",
        checkpoint,
      },
    }),
  );
  step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 1, now: at(1) }),
  ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now: at(1) }));
  const redirected = {
    ...product,
    key: alias + "products/new",
    sourceUrl: alias + "products/new",
  };
  checkpoint = {
    ...checkpoint,
    pending: null,
    candidateUrls: [redirected.key],
    preview: { products: [redirected], warnings: [] },
  };
  const finished = await run((r) =>
    r.completeStep({
      ...step,
      now: at(1),
      observation: { documentUrl: redirected.key, state: "ready", checkpoint },
    }),
  );
  expect(finished.checkpoint.preview.products[0]?.sourceUrl).toBe(
    redirected.key,
  );
});

it("requires robots reapproval after homepage canonicalization before retaining products", async () => {
  const scan = await create();
  let step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 0, now }),
  ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now }));
  let checkpoint: WebsiteCheckpoint = {
    ...scan.checkpoint,
    robotsPolicy: {
      origin: "https://store.example/",
      state: "ready",
      directives: [],
      sitemapLinks: [],
      crawlDelaySeconds: 1,
      warnings: [],
    },
    pending: { url: "https://store.example/", kind: "discovery" },
    nextEligibleAt: at(1).toISOString(),
  };
  await run((r) =>
    r.completeStep({
      ...step,
      now,
      observation: { state: "running", checkpoint },
    }),
  );
  step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 1, now: at(1) }),
  ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now: at(1) }));
  const alias = "https://www.store.example/";
  const unsafe = {
    ...checkpoint,
    canonicalOrigin: alias,
    pending: { url: alias + "products/one", kind: "product" as const },
    candidateUrls: [alias + "products/one"],
    nextEligibleAt: at(2).toISOString(),
  };
  await expect(
    run((r) =>
      r.completeStep({
        ...step,
        now: at(1),
        observation: {
          documentUrl: alias,
          state: "running",
          checkpoint: unsafe,
        },
      }),
    ),
  ).rejects.toThrow("robots");
  checkpoint = {
    ...checkpoint,
    canonicalOrigin: alias,
    pending: { url: alias + "robots.txt", kind: "robots" },
    nextEligibleAt: at(2).toISOString(),
  };
  await run((r) =>
    r.completeStep({
      ...step,
      now: at(1),
      observation: { documentUrl: alias, state: "running", checkpoint },
    }),
  );
  expect(
    (await run((r) => r.getScan(scan.id)))?.checkpoint.preview.products,
  ).toEqual([]);
});

it("denies runtime forged product inserts and terminal scan mutations", async () => {
  const scan = await create();
  const forged = {
    ...product,
    key: "https://store.example/forged",
    sourceUrl: "https://store.example/forged",
  };
  const app = postgres(appUrl!, { max: 1, prepare: false });
  try {
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`insert into website_products(workspace_id,canonical_source_url,source_scan_id,source_key,observation,saved_by) values (${ws},${forged.sourceUrl},${scan.id},${forged.key},${tx.json(forged)},${ws + "op"})`;
      }),
    ).rejects.toThrow();
    const step = (await run((r) =>
      r.claimStep({ scanId: scan.id, revision: 0, now }),
    ))!;
    await run((r) => r.beginDocumentFetch({ ...step, now }));
    await run((r) =>
      r.completeStep({
        ...step,
        now,
        observation: {
          state: "failed",
          checkpoint: { ...scan.checkpoint, pending: null },
        },
      }),
    );
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`update website_scans set state='running' where id=${scan.id}`;
      }),
    ).rejects.toThrow("immutable");
  } finally {
    await app.end();
  }
});

it("counts failed document starts against discovery budget and retains retry spacing", async () => {
  const scan = await create();
  let step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 0, now }),
  ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now }));
  let checkpoint: WebsiteCheckpoint = {
    ...scan.checkpoint,
    robotsPolicy: {
      origin: "https://store.example/",
      state: "ready",
      directives: [],
      sitemapLinks: [],
      crawlDelaySeconds: 90,
      warnings: [],
    },
    pending: { kind: "discovery", url: "https://store.example/" },
    nextEligibleAt: at(90).toISOString(),
  };
  await run((r) =>
    r.completeStep({
      ...step,
      now,
      observation: { state: "running", checkpoint },
    }),
  );
  step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 1, now: at(90) }),
  ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now: at(90) }));
  // The fetch crashes; lease expires at150 but policy still forbids the next start before180.
  expect(
    await run((r) =>
      r.claimStep({ scanId: scan.id, revision: 1, now: at(151) }),
    ),
  ).toBeNull();
  step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 1, now: at(180) }),
  ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now: at(180) }));
  checkpoint = {
    ...checkpoint,
    canonicalOrigin: "https://store.example/",
    nextEligibleAt: at(270).toISOString(),
  };
  await run((r) =>
    r.completeStep({
      ...step,
      now: at(180),
      observation: { state: "running", checkpoint },
    }),
  );
  for (const [revision, time] of [
    [2, 270],
    [3, 360],
    [4, 450],
  ] as const) {
    step = (await run((r) =>
      r.claimStep({ scanId: scan.id, revision, now: at(time) }),
    ))!;
    await run((r) => r.beginDocumentFetch({ ...step, now: at(time) }));
    checkpoint = { ...checkpoint, nextEligibleAt: at(time + 90).toISOString() };
    await run((r) =>
      r.completeStep({
        ...step,
        now: at(time),
        observation: { state: "running", checkpoint },
      }),
    );
  }
  step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 5, now: at(540) }),
  ))!;
  expect(
    (await run((r) => r.beginDocumentFetch({ ...step, now: at(540) }))).status,
  ).toBe("stale");
  const exhausted = await run((r) => r.getScan(scan.id));
  expect(exhausted?.discoveryRequests).toBe(5);
  expect(exhausted?.state).toBe("failed");
});

it("expires at fifteen minutes and exposes only bounded sweeper identities", async () => {
  const scan = await create();
  expect(scan.deadlineAt.getTime() - now.getTime()).toBe(900000);
  expect(
    await run((r) =>
      r.claimStep({ scanId: scan.id, revision: 0, now: at(900) }),
    ),
  ).toBeNull();
  expect((await run((r) => r.getScan(scan.id)))?.state).toBe("failed");
  const due = await run((r) =>
    r.createScan({
      url: "https://store.example/",
      requestedBy: ws + "op",
      requestKey: randomUUID(),
      now: new Date(Date.now() - 120000),
    }),
  );
  const rows = await db.findStuckWebsiteScans({ maxRows: 10 });
  expect(rows.length).toBeLessThanOrEqual(10);
  expect(rows).toContainEqual({ workspaceId: ws, scanId: due.id, revision: 0 });
  for (const row of rows)
    expect(Object.keys(row).sort()).toEqual([
      "revision",
      "scanId",
      "workspaceId",
    ]);
  expect(rows.some((r) => r.scanId === scan.id)).toBe(false);
  const permissions =
    await admin`select has_function_privilege('public','sweeper_find_website_scans(integer)','EXECUTE') as public_access,has_function_privilege('wukong_app','sweeper_find_website_scans(integer)','EXECUTE') as app_access`;
  expect(permissions[0]).toMatchObject({
    public_access: false,
    app_access: true,
  });
  expect(
    (await run((r) => r.listDispatchable({ now, limit: 100 }))).some(
      (r) => r.id === due.id,
    ),
  ).toBe(true);
});

it("rejects viewer create and retains reviewer/admin/owner inheritance", async () => {
  await expect(
    run((r) =>
      r.createScan({
        url: "https://store.example/",
        requestKey: randomUUID(),
        requestedBy: ws + "view",
        now,
      }),
    ),
  ).rejects.toThrow("operator");
  for (const role of ["reviewer", "admin", "owner"]) {
    const id = ws + role;
    await admin`insert into users(id,email) values (${id},${id + "@example.test"})`;
    await admin`insert into memberships(workspace_id,user_id,role) values (${ws},${id},${role})`;
    expect(
      (
        await run((r) =>
          r.createScan({
            url: "https://store.example/",
            requestKey: randomUUID(),
            requestedBy: id,
            now,
          }),
        )
      ).requestedBy,
    ).toBe(id);
  }
});

it("ends at deadline even when crawl delay moves the next request past it", async () => {
  const scan = await create(),
    step = (await run((r) =>
      r.claimStep({ scanId: scan.id, revision: 0, now }),
    ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now }));
  const checkpoint: WebsiteCheckpoint = {
    ...scan.checkpoint,
    robotsPolicy: {
      origin: "https://store.example/",
      state: "ready",
      directives: [],
      sitemapLinks: [],
      crawlDelaySeconds: 3600,
      warnings: [],
    },
    pending: { kind: "discovery", url: "https://store.example/" },
    nextEligibleAt: at(3600).toISOString(),
  };
  await run((r) =>
    r.completeStep({
      ...step,
      now,
      observation: { state: "running", checkpoint },
    }),
  );
  await run((r) => r.claimStep({ scanId: scan.id, revision: 1, now: at(900) }));
  expect((await run((r) => r.getScan(scan.id)))?.state).toBe("failed");
});

it("enforces raw runtime RLS and composite scan foreign keys", async () => {
  const scan = await create(),
    app = postgres(appUrl!, { max: 1, prepare: false });
  try {
    const visible = await app.begin(async (tx) => {
      await tx`select set_config('app.workspace_id',${other},true)`;
      return tx`select id from website_scans where id=${scan.id}`;
    });
    expect(visible).toHaveLength(0);
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${other},true)`;
        await tx`insert into website_scan_steps(workspace_id,scan_id,revision,lease_token,request_state) values (${other},${scan.id},0,${randomUUID()},'idle')`;
      }),
    ).rejects.toThrow();
    const flags =
      await admin`select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('website_scans','website_scan_steps','website_products')`;
    expect(flags).toHaveLength(3);
    for (const flag of flags)
      expect(flag).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
  } finally {
    await app.end();
  }
});

it("stops after rate-limited robots instead of scheduling an automatic retry", async () => {
  const scan = await create(),
    step = (await run((r) =>
      r.claimStep({ scanId: scan.id, revision: 0, now }),
    ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now }));
  const checkpoint: WebsiteCheckpoint = {
    ...scan.checkpoint,
    robotsPolicy: {
      origin: "https://store.example/",
      state: "rate_limited",
      directives: [],
      sitemapLinks: [],
      crawlDelaySeconds: 1,
      warnings: ["robots_rate_limited"],
    },
    nextEligibleAt: at(1).toISOString(),
  };
  await expect(
    run((r) =>
      r.completeStep({
        ...step,
        now,
        observation: { state: "running", checkpoint },
      }),
    ),
  ).rejects.toThrow("Robots policy");
});

it("counts every product start, retains twenty observations, and finishes partial at budget", async () => {
  const scan = await create(),
    urls = Array.from(
      { length: 20 },
      (_, i) => `https://store.example/budget-${i}`,
    );
  let step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 0, now }),
  ))!;
  await run((r) => r.beginDocumentFetch({ ...step, now }));
  let checkpoint: WebsiteCheckpoint = {
    ...scan.checkpoint,
    canonicalOrigin: "https://store.example/",
    robotsPolicy: {
      origin: "https://store.example/",
      state: "ready",
      directives: [],
      sitemapLinks: [],
      crawlDelaySeconds: 1,
      warnings: [],
    },
    candidateUrls: urls,
    pending: { kind: "product", url: urls[0]! },
    nextEligibleAt: at(1).toISOString(),
  };
  await run((r) =>
    r.completeStep({
      ...step,
      now,
      observation: { state: "running", checkpoint },
    }),
  );
  for (let i = 0; i < 20; i++) {
    step = (await run((r) =>
      r.claimStep({ scanId: scan.id, revision: i + 1, now: at(i + 1) }),
    ))!;
    const started = await run((r) =>
      r.beginDocumentFetch({ ...step, now: at(i + 1) }),
    );
    expect(started.status).toBe("claimed");
    checkpoint = {
      ...checkpoint,
      preview: {
        products: [
          ...checkpoint.preview.products,
          { ...product, key: urls[i]!, sourceUrl: urls[i]! },
        ],
        warnings: [],
      },
      pending: { kind: "product", url: urls[Math.min(i + 1, 19)]! },
      nextEligibleAt: at(i + 2).toISOString(),
    };
    await run((r) =>
      r.completeStep({
        ...step,
        now: at(i + 1),
        observation: { state: "running", checkpoint },
      }),
    );
  }
  step = (await run((r) =>
    r.claimStep({ scanId: scan.id, revision: 21, now: at(21) }),
  ))!;
  expect(
    (await run((r) => r.beginDocumentFetch({ ...step, now: at(21) }))).status,
  ).toBe("stale");
  const finished = await run((r) => r.getScan(scan.id));
  expect(finished?.state).toBe("partial");
  expect(finished?.productRequests).toBe(20);
  expect(finished?.checkpoint.preview.products).toHaveLength(20);
  const saved = await run((r) =>
    r.saveSelection({ scanId: scan.id, keys: [urls[0]!], actorId: ws + "op" }),
  );
  expect(saved.savedIds).toHaveLength(1);
});
