import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webEvidence } from "@wukong/core";
import { createDatabase } from "../index.js";
const db = createDatabase(process.env.TEST_DATABASE_URL!, {
  migrationUrl: process.env.TEST_DATABASE_ADMIN_URL!,
});
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  onnotice: () => {},
});
const app = postgres(process.env.TEST_DATABASE_URL!, { onnotice: () => {} });
const ws = `acquisition-${randomUUID()}`;
beforeAll(async () => {
  await db.migrate();
  await admin.unsafe(
    await readFile(
      new URL("../../drizzle/0042_wine_acquisition.sql", import.meta.url),
      "utf8",
    ),
  );
});
afterAll(async () => {
  await db.close();
  await admin.end();
  await app.end();
});
async function fixture(change: Record<string, unknown> = {}) {
  const source = webEvidence({
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
  });
  return db.forWorkspace(ws, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 0,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      execution: {
        schemaVersion: 1,
        flowVersion: "wine-enrichment-v1",
        wineMode: "full",
        wineAcquisition: {
          schemaVersion: 1,
          deadlineAt: new Date(Date.now() + 840000).toISOString(),
          policyVersion: "p1",
          rulesVersion: "r1",
          allowedDomains: [source.domain],
          ...change,
        },
      },
    });
    await r.wineEnrichment.saveEvidence(run.id, [source]);
    return {
      listing,
      run,
      source,
      request: {
        workspaceId: ws,
        runId: run.id,
        sourceId: source.id,
        inputRevision: 0,
        kind: "product" as const,
      },
    };
  });
}
const claim = (request: Awaited<ReturnType<typeof fixture>>["request"]) =>
  db.forWorkspace(request.workspaceId, (r) =>
    r.wineAcquisition.claimDocument(request),
  );
function result(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    ...f.request,
    schemaVersion: 1 as const,
    state: "ready" as const,
    url: f.source.url!,
    capturedAt: new Date().toISOString(),
    title: "Wine",
    text: "wine",
    spans: [{ start: 0, end: 4, location: "body:text" }],
    documentDigest: "sha256:" + "a".repeat(64),
    truncated: false,
    warnings: [],
    extractEligible: true,
  };
}
describe("durable wine acquisition", () => {
  it("admits one parallel claim, replays unknown then immutable terminal result", async () => {
    const f = await fixture();
    const states = await Promise.all([claim(f.request), claim(f.request)]);
    expect(states.map((x) => x.state).sort()).toEqual(["claimed", "unknown"]);
    expect(states.find((x) => x.state === "claimed")).toMatchObject({
      context: {
        source: f.source,
        currentRunId: f.run.id,
        inputRevision: 0,
        allowedDomains: [f.source.domain],
      },
    });
    const output = result(f);
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineAcquisition.finishDocument(f.request, output),
      ),
    ).toBe(true);
    expect(await claim(f.request)).toEqual({
      state: "completed",
      result: output,
    });
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineAcquisition.finishDocument(f.request, {
          ...output,
          title: "changed",
        }),
      ),
    ).toBe(false);
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`update wine_document_requests set result='{}'::jsonb where run_id=${f.run.id}`;
      }),
    ).rejects.toThrow();
  });
  it("rejects stale revision, foreign source, expired or malformed accepted policy", async () => {
    const f = await fixture();
    expect(await claim({ ...f.request, inputRevision: 1 })).toEqual({
      state: "stale",
    });
    expect(await claim({ ...f.request, sourceId: randomUUID() })).toEqual({
      state: "stale",
    });
    expect(
      await claim({ ...f.request, workspaceId: `foreign-${randomUUID()}` }),
    ).toEqual({ state: "stale" });
    for (const change of [
      { deadlineAt: new Date(Date.now() - 1).toISOString() },
      { deadlineAt: new Date(Date.now() + 960000).toISOString() },
      { policyVersion: "" },
      { allowedDomains: ["other.test"] },
    ]) {
      expect(await claim((await fixture(change)).request)).toEqual({
        state: "stale",
      });
    }
  });
  it("revalidates completed replay and finish against current listing and run", async () => {
    const f = await fixture();
    await claim(f.request);
    await admin`update listing_drafts set input_revision=1 where id=${f.listing.id}`;
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineAcquisition.finishDocument(f.request, result(f)),
      ),
    ).toBe(false);
    expect(await claim(f.request)).toEqual({ state: "stale" });
    const g = await fixture();
    await claim(g.request);
    await db.forWorkspace(ws, (r) =>
      r.wineAcquisition.finishDocument(g.request, result(g)),
    );
    await admin`update listing_drafts set current_run_id=null where id=${g.listing.id}`;
    expect(await claim(g.request)).toEqual({ state: "stale" });
  });
  it("persists bounded search output atomically and retains discrepancy holds", async () => {
    const f = await fixture();
    const call = {
      runId: f.run.id,
      slot: "basic_1" as const,
      maximumCredits: 1,
      requestDigest: "digest",
    };
    const output = {
      schemaVersion: 1,
      results: [
        { url: f.source.url, title: "wine", content: "wine", truncated: false },
      ],
      requestId: "fixture-request",
    };
    await db.forWorkspace(ws, async (r) => {
      await r.searchBudgetReservations.reserve({
        pipelineRunId: f.run.id,
        reservedCredits: 5,
        workspaceCapCredits: 1000,
        policyVersion: "p1",
      });
      expect(await r.wineEnrichment.beginSearchCall(call)).toBe(true);
      expect(
        await r.wineEnrichment.readSearchCall(f.run.id, "basic_1"),
      ).toMatchObject({ status: "started", output: null });
      await expect(
        r.wineEnrichment.finishSearchCall({
          ...call,
          status: "succeeded",
          credits: 1,
          output: {
            ...output,
            results: [{ ...output.results[0], content: "x".repeat(16001) }],
          },
        }),
      ).rejects.toThrow();
      expect(
        await r.wineEnrichment.readSearchCall(f.run.id, "basic_1"),
      ).toMatchObject({ status: "started", output: null, credits: null });
      expect(
        await r.wineEnrichment.finishSearchCall({
          ...call,
          status: "unknown",
          credits: null,
          diagnostic: {
            schemaVersion: 1,
            code: "cost_discrepancy",
            requestId: "fixture-request",
            measuredCredits: 2,
            reservedCredits: 1,
            httpStatus: 200,
          },
        }),
      ).toBe(true);
      expect(
        await r.wineEnrichment.readSearchCall(f.run.id, "basic_1"),
      ).toMatchObject({
        status: "unknown",
        diagnostic: { measuredCredits: 2, reservedCredits: 1 },
      });
      expect(await r.searchBudgetReservations.settleFromCalls(f.run.id)).toBe(
        "unknown",
      );
    });
  });
  it("replays successful normalized search output and never repairs legacy terminal rows", async () => {
    const f = await fixture();
    await db.forWorkspace(ws, async (r) => {
      await r.searchBudgetReservations.reserve({
        pipelineRunId: f.run.id,
        reservedCredits: 5,
        workspaceCapCredits: 1000,
        policyVersion: "p1",
      });
      for (const slot of ["basic_1", "basic_2"] as const) {
        const call = {
          runId: f.run.id,
          slot,
          maximumCredits: 1,
          requestDigest: slot,
        };
        await r.wineEnrichment.beginSearchCall(call);
        const output =
          slot === "basic_1"
            ? { schemaVersion: 1 as const, results: [], requestId: null }
            : undefined;
        expect(
          await r.wineEnrichment.finishSearchCall({
            ...call,
            status: "succeeded",
            credits: 1,
            output,
          }),
        ).toBe(true);
        expect(await r.wineEnrichment.beginSearchCall(call)).toBe(false);
        expect(
          await r.wineEnrichment.readSearchCall(f.run.id, slot),
        ).toMatchObject({ status: "succeeded", output: output ?? null });
      }
    });
  });
  it("keeps immutable workspace cache snapshots with exact seven-day expiry", async () => {
    const f = await fixture();
    const key = {
      identityKey: "identity",
      policyVersion: "p1",
      rulesVersion: "r1",
    };
    const snapshot = {
      snapshotId: randomUUID(),
      runId: f.run.id,
      ...key,
      sourceIds: [f.source.id],
    };
    const saved = await db.forWorkspace(ws, (r) =>
      r.wineAcquisition.saveCacheSnapshot(snapshot),
    );
    const replay = await db.forWorkspace(ws, (r) =>
      r.wineAcquisition.saveCacheSnapshot(snapshot),
    );
    expect(replay).toEqual(saved);
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineAcquisition.readCacheSnapshot(key),
      ),
    ).toEqual(saved);
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineAcquisition.readCacheSnapshot({ ...key, rulesVersion: "other" }),
      ),
    ).toBeNull();
    expect(
      await db.forWorkspace(`other-${randomUUID()}`, (r) =>
        r.wineAcquisition.readCacheSnapshot(key),
      ),
    ).toBeNull();
    await expect(
      db.forWorkspace(ws, (r) =>
        r.wineAcquisition.saveCacheSnapshot({
          ...snapshot,
          identityKey: "changed",
        }),
      ),
    ).rejects.toThrow("immutable");
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`update wine_evidence_cache set captured_at=clock_timestamp() where snapshot_id=${snapshot.snapshotId}`;
      }),
    ).rejects.toThrow();
    // A raw caller cannot invent a captured timestamp to renew or backdate the payload.
    const expiredId = randomUUID();
    await expect(
      admin`insert into wine_evidence_cache(workspace_id,snapshot_id,run_id,identity_key,policy_version,rules_version,captured_at,payload) values(${ws},${expiredId},${f.run.id},'expired','p1','r1',clock_timestamp()-interval '7 days',${admin.json(saved.payload)})`,
    ).rejects.toThrow();
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineAcquisition.readCacheSnapshot({ ...key, identityKey: "expired" }),
      ),
    ).toBeNull();
  });
});
describe("acquisition security inventory and raw SQL", () => {
  it("exports schema declarations and detects acquisition grant/policy/constraint drift", async () => {
    const schema = await import("../schema.js");
    expect(schema).toHaveProperty("wineDocumentRequests");
    expect(schema).toHaveProperty("wineEvidenceCache");
    expect(await db.inspectWineEnrichmentCompatibility()).toMatchObject({
      ready: true,
    });
    try {
      await admin`revoke update on wine_document_requests from wukong_app`;
      expect(await db.inspectWineEnrichmentCompatibility()).toMatchObject({
        ready: false,
      });
    } finally {
      await admin`grant update on wine_document_requests to wukong_app`;
    }
    try {
      await admin`create policy bad_acquisition on wine_evidence_cache for select to wukong_app using(true)`;
      expect(await db.inspectWineEnrichmentCompatibility()).toMatchObject({
        ready: false,
      });
    } finally {
      await admin`drop policy if exists bad_acquisition on wine_evidence_cache`;
    }
    const [constraint] =
      await admin`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='wine_document_requests'::regclass and conname='wine_document_result_check'`;
    try {
      await admin`alter table wine_document_requests drop constraint wine_document_result_check`;
      await admin`alter table wine_document_requests add constraint wine_document_result_check check(true)`;
      expect(await db.inspectWineEnrichmentCompatibility()).toMatchObject({
        ready: false,
      });
    } finally {
      await admin`alter table wine_document_requests drop constraint wine_document_result_check`;
      await admin.unsafe(
        "alter table wine_document_requests add constraint wine_document_result_check " +
          constraint!.definition,
      );
    }
  });
  it("preserves runtime RLS, foreign keys and SQL NULL result defenses", async () => {
    const f = await fixture();
    await claim(f.request);
    const rows = await app.begin(async (tx) => {
      await tx`select set_config('app.workspace_id','foreign',true)`;
      return tx`select * from wine_document_requests where run_id=${f.run.id}`;
    });
    expect(rows).toHaveLength(0);
    for (const payload of [
      null,
      { schemaVersion: null },
      { schemaVersion: "1" },
      { schemaVersion: 1 },
    ]) {
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id',${ws},true)`;
          await tx`update wine_document_requests set state='completed',result=${payload === null ? null : tx.json(payload)} where run_id=${f.run.id}`;
        }),
      ).rejects.toThrow();
    }
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`insert into wine_document_requests(workspace_id,run_id,source_id,kind,input_revision) values(${ws},${f.run.id},${randomUUID()},'robots',0)`;
      }),
    ).rejects.toThrow();
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id','foreign',true)`;
        await tx`insert into wine_document_requests(workspace_id,run_id,source_id,kind,input_revision) values(${ws},${f.run.id},${f.source.id},'robots',0)`;
      }),
    ).rejects.toThrow();
  });
  it("replays the additive migration without resetting snapshots", async () => {
    const sql = await readFile(
      new URL("../../drizzle/0042_wine_acquisition.sql", import.meta.url),
      "utf8",
    );
    const before =
      await admin`select count(*)::int as count from wine_document_requests`;
    await admin.unsafe(sql);
    await admin.unsafe(sql);
    expect(
      await admin`select count(*)::int as count from wine_document_requests`,
    ).toEqual(before);
    expect(await db.inspectWineEnrichmentCompatibility()).toMatchObject({
      ready: true,
    });
  });
});
describe("freshness and content edge cases", () => {
  it("rejects a new cache snapshot that reuses previously cached source IDs", async () => {
    const f = await fixture();
    const input = {
      snapshotId: randomUUID(),
      runId: f.run.id,
      identityKey: randomUUID(),
      policyVersion: "p1",
      rulesVersion: "r1",
      sourceIds: [f.source.id],
    };
    await db.forWorkspace(ws, (r) =>
      r.wineAcquisition.saveCacheSnapshot(input),
    );
    await expect(
      db.forWorkspace(ws, (r) =>
        r.wineAcquisition.saveCacheSnapshot({
          ...input,
          snapshotId: randomUUID(),
        }),
      ),
    ).rejects.toThrow("fresh evidence");
  });
  it("expires claims while waiting for the listing lock using the database clock", async () => {
    const f = await fixture({
      deadlineAt: new Date(Date.now() + 350).toISOString(),
    });
    let signal!: () => void;
    const locked = new Promise<void>((r) => (signal = r));
    const blocker = admin.begin(async (tx) => {
      await tx`select id from listing_drafts where id=${f.listing.id} for update`;
      signal();
      await tx`select pg_sleep(0.5)`;
    });
    await locked;
    expect(await claim(f.request)).toEqual({ state: "stale" });
    await blocker;
  });
  it("rejects wrongly bound result and safe diagnostic extensions before any mutation", async () => {
    const f = await fixture();
    await claim(f.request);
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineAcquisition.finishDocument(f.request, {
          ...result(f),
          sourceId: randomUUID(),
        }),
      ),
    ).toBe(false);
    expect(await claim(f.request)).toEqual({ state: "unknown" });
  });
});
describe("final durable boundary checks", () => {
  it("returns service admission only after commit and ignores injected wall time", async () => {
    const { createWineDocumentStore } = await import("../index.js");
    const f = await fixture();
    const store = createWineDocumentStore(db);
    expect(
      await store.claim(f.request, "1900-01-01T00:00:00.000Z"),
    ).toMatchObject({ state: "claimed" });
    const [row] =
      await admin`select state from wine_document_requests where run_id=${f.run.id}`;
    expect(row!.state).toBe("started");
    expect(
      await store.finish(f.request, result(f), "1900-01-01T00:00:00.000Z"),
    ).toBe(true);
    await admin`update listing_pipeline_runs set execution_state='failed',status='failed' where id=${f.run.id}`;
    expect(await store.claim(f.request, new Date().toISOString())).toEqual({
      state: "stale",
    });
  });
  it("rejects raw partial search output without changing status or credits", async () => {
    const f = await fixture();
    await db.forWorkspace(ws, async (r) => {
      await r.searchBudgetReservations.reserve({
        pipelineRunId: f.run.id,
        reservedCredits: 5,
        workspaceCapCredits: 1000,
        policyVersion: "p1",
      });
      await r.wineEnrichment.beginSearchCall({
        runId: f.run.id,
        slot: "basic_1",
        maximumCredits: 1,
        requestDigest: "raw",
      });
    });
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`update wine_search_calls set output='{"schemaVersion":1}'::jsonb where run_id=${f.run.id}`;
      }),
    ).rejects.toThrow();
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineEnrichment.readSearchCall(f.run.id, "basic_1"),
      ),
    ).toMatchObject({ status: "started", credits: null, output: null });
  });
  it("fails readiness when the acquisition lookup index is missing", async () => {
    const [row] =
      await admin`select pg_get_indexdef('wine_cache_lookup_idx'::regclass) as definition`;
    try {
      await admin`drop index wine_cache_lookup_idx`;
      expect(await db.inspectWineEnrichmentCompatibility()).toMatchObject({
        ready: false,
      });
    } finally {
      await admin.unsafe(row!.definition);
    }
  });
});
describe("cache source-time freshness", () => {
  async function sourcesAt(times: string[]) {
    const f = await fixture();
    const sources = times.map((capturedAt) =>
      webEvidence({ id: randomUUID(), capturedAt }),
    );
    await db.forWorkspace(ws, (r) =>
      r.wineEnrichment.saveEvidence(f.run.id, sources),
    );
    return {
      f,
      sources,
      input: {
        snapshotId: randomUUID(),
        runId: f.run.id,
        identityKey: randomUUID(),
        policyVersion: "p1",
        rulesVersion: "r1",
        sourceIds: sources.map((s) => s.id),
      },
    };
  }
  it.each([8 * 86400000, 7 * 86400000, -60000])(
    "rejects first publication at invalid source age %s",
    async (age) => {
      const { input } = await sourcesAt([
        new Date(Date.now() - age).toISOString(),
      ]);
      await expect(
        db.forWorkspace(ws, (r) => r.wineAcquisition.saveCacheSnapshot(input)),
      ).rejects.toThrow("source");
    },
  );
  it("anchors mixed source ages to the oldest capture and preserves replay", async () => {
    const times = [
      new Date(Date.now() - 6 * 86400000).toISOString(),
      new Date().toISOString(),
    ];
    const { input } = await sourcesAt(times);
    const saved = await db.forWorkspace(ws, (r) =>
      r.wineAcquisition.saveCacheSnapshot(input),
    );
    expect(saved.capturedAt).toBe(times[0]);
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineAcquisition.saveCacheSnapshot(input),
      ),
    ).toEqual(saved);
  });
  it("rejects a future member mixed with a valid older source", async () => {
    const { input } = await sourcesAt([
      new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() + 60000).toISOString(),
    ]);
    await expect(
      db.forWorkspace(ws, (r) => r.wineAcquisition.saveCacheSnapshot(input)),
    ).rejects.toThrow("source");
  });
  it("does not refresh copied old evidence by giving it fresh IDs", async () => {
    const old = new Date(Date.now() - 8 * 86400000).toISOString();
    const first = await sourcesAt([old]);
    const copied = { ...first.sources[0]!, id: randomUUID() };
    await db.forWorkspace(ws, (r) =>
      r.wineEnrichment.saveEvidence(first.f.run.id, [copied]),
    );
    await expect(
      db.forWorkspace(ws, (r) =>
        r.wineAcquisition.saveCacheSnapshot({
          ...first.input,
          snapshotId: randomUUID(),
          sourceIds: [copied.id],
        }),
      ),
    ).rejects.toThrow("source");
  });
  it("expires a valid snapshot when the oldest source reaches seven days", async () => {
    const { input } = await sourcesAt([
      new Date(Date.now() - 7 * 86400000 + 1500).toISOString(),
    ]);
    await db.forWorkspace(ws, (r) =>
      r.wineAcquisition.saveCacheSnapshot(input),
    );
    await admin`select pg_sleep(1.6)`;
    expect(
      await db.forWorkspace(ws, (r) =>
        r.wineAcquisition.readCacheSnapshot({
          identityKey: input.identityKey,
          policyVersion: "p1",
          rulesVersion: "r1",
        }),
      ),
    ).toBeNull();
  });
  it("rejects raw SQL publication-time renewal and expired source insertion", async () => {
    const { f, sources } = await sourcesAt([
      new Date(Date.now() - 6 * 86400000).toISOString(),
    ]);
    const insert = (capturedAt: string, payload: unknown) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`insert into wine_evidence_cache(workspace_id,snapshot_id,run_id,identity_key,policy_version,rules_version,captured_at,payload) values(${ws},${randomUUID()},${f.run.id},'raw-time','p1','r1',${capturedAt},${tx.json(payload as never)})`;
      });
    await expect(
      insert(new Date().toISOString(), { schemaVersion: 1, sources }),
    ).rejects.toThrow();
    const old = new Date(Date.now() - 8 * 86400000).toISOString();
    await expect(
      insert(old, {
        schemaVersion: 1,
        sources: [{ ...sources[0], capturedAt: old }],
      }),
    ).rejects.toThrow();
  });
});
describe("cache freshness readiness", () => {
  it("fails closed if the source-time insert guard is disabled", async () => {
    try {
      await admin`alter table wine_evidence_cache disable trigger wine_cache_freshness_guard`;
      expect(await db.inspectWineEnrichmentCompatibility()).toMatchObject({
        ready: false,
      });
    } finally {
      await admin`alter table wine_evidence_cache enable trigger wine_cache_freshness_guard`;
    }
  });
});
