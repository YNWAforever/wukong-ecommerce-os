import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webEvidence } from "@wukong/core";
import { createDatabase, type WorkspaceRepositories } from "../index.js";
const db = createDatabase(process.env.TEST_DATABASE_URL!, {
  migrationUrl: process.env.TEST_DATABASE_ADMIN_URL!,
});
const ws = `wine-${randomUUID()}`;
async function run(repos: WorkspaceRepositories) {
  const listing = await repos.listings.create({ target: "shopline" });
  return repos.pipelineRuns.acceptOperation({
    listingId: listing.id,
    inputRevision: 1,
    baseVersionId: null,
    activeVersionSequence: 0,
    requestKey: randomUUID(),
    requestDigest: randomUUID(),
    execution: { flowVersion: "wine-enrichment-v1", schemaVersion: 1 },
  });
}
beforeAll(() => db.migrate());
afterAll(() => db.close());
describe("durable wine persistence", () => {
  it("claims once, rejects stale completion and preserves terminal output", async () => {
    await db.forWorkspace(ws, async (r) => {
      const operation = await run(r);
      const claim = {
        runId: operation.id,
        stage: "extraction" as const,
        inputDigest: "input",
        dependencyDigest: "dep",
      };
      expect(await r.wineEnrichment.claimStage(claim)).toBe(true);
      expect(await r.wineEnrichment.claimStage(claim)).toBe(false);
      const done = {
        ...claim,
        state: "succeeded" as const,
        output: { schemaVersion: 1, value: "first" },
        updatedAt: new Date().toISOString(),
      };
      expect(
        await r.wineEnrichment.finishStage({
          ...done,
          dependencyDigest: "stale",
        }),
      ).toBe(false);
      expect(await r.wineEnrichment.finishStage(done)).toBe(true);
      expect(
        await r.wineEnrichment.finishStage({
          ...done,
          output: { value: "changed" },
        }),
      ).toBe(false);
      expect(
        (await r.wineEnrichment.readStage(operation.id, "extraction"))?.output,
      ).toEqual(done.output);
    });
  });
  it("isolates evidence and stages across workspaces and freezes evidence IDs", async () => {
    const id = await db.forWorkspace(ws, async (r) => {
      const operation = await run(r);
      const source = webEvidence();
      await r.wineEnrichment.saveEvidence(operation.id, [source]);
      await r.wineEnrichment.saveEvidence(operation.id, [source]);
      await expect(
        r.wineEnrichment.saveEvidence(operation.id, [
          { ...source, title: "changed" },
        ]),
      ).rejects.toThrow("immutable");
      expect(await r.wineEnrichment.readEvidence(operation.id)).toEqual([
        source,
      ]);
      return operation.id;
    });
    await db.forWorkspace(`other-${randomUUID()}`, async (r) => {
      expect(await r.wineEnrichment.readEvidence(id)).toEqual([]);
      expect(await r.wineEnrichment.readStage(id, "extraction")).toBeNull();
    });
  });
  it("suppresses search replay and retains terminal unknown usage", async () => {
    await db.forWorkspace(ws, async (r) => {
      const operation = await run(r);
      await r.searchBudgetReservations.reserve({
        pipelineRunId: operation.id,
        reservedCredits: 5,
        workspaceCapCredits: 100,
        policyVersion: "v1",
      });
      const call = {
        runId: operation.id,
        slot: "basic_1" as const,
        maximumCredits: 1,
        requestDigest: "request",
      };
      expect(await r.wineEnrichment.beginSearchCall(call)).toBe(true);
      expect(await r.wineEnrichment.beginSearchCall(call)).toBe(false);
      expect(
        await r.wineEnrichment.finishSearchCall({
          ...call,
          credits: null,
          status: "unknown",
        }),
      ).toBe(true);
      expect(
        await r.wineEnrichment.finishSearchCall({
          ...call,
          credits: 0,
          status: "failed",
        }),
      ).toBe(false);
      expect(
        await r.searchBudgetReservations.settleFromCalls(operation.id),
      ).toBe("unknown");
      expect(
        await r.searchBudgetReservations.settleFromCalls(operation.id),
      ).toBe("unknown");
    });
  });
  it("requires independently authorized reviewers for strict authority records", async () => {
    await db.forWorkspace(ws, async (r) => {
      await expect(
        r.wineEnrichment.recordReviewedAuthority("unknown-reviewer", {
          schemaVersion: 1,
          domain: "example.test",
          subject: { kind: "producer", name: "Fixture Estate" },
          proofUrl: "https://example.test/proof",
          proofDigest: "a".repeat(64),
          verifiedAt: new Date().toISOString(),
          expiresAt: "2027-01-01T00:00:00.000Z",
          revokedAt: null,
          verifierId: "unknown-reviewer",
        }),
      ).rejects.toThrow("reviewer");
      expect(await r.wineEnrichment.readAuthorities()).toEqual([]);
    });
  });
  it("reports migration readiness under runtime role and replays migration safely", async () => {
    expect(await db.inspectWineEnrichmentCompatibility()).toMatchObject({
      ready: true,
      missing: [],
    });
    await db.migrate();
    expect(await db.inspectWineEnrichmentCompatibility()).toMatchObject({
      ready: true,
    });
  });
});

// Catalog/security probes deliberately use the fixture owner only for setup and drift simulation.
// All assertions about reads/writes use the non-owner application connection.
describe("wine persistence security and replay", () => {
  it("requires all schema exports and accepts wine verification ledger tasks", async () => {
    const schema = await import("../schema.js");
    expect(schema).toHaveProperty("wineStages");
    expect(schema).toHaveProperty("wineEvidence");
    expect(schema).toHaveProperty("wineSectionSnapshots");
    expect(schema).toHaveProperty("wineSourceAuthorities");
    expect(schema).toHaveProperty("wineTrustedContexts");
    expect(schema).toHaveProperty("searchBudgetReservations");
    expect(schema).toHaveProperty("wineSearchCalls");
  });
});

describe("security catalog and trusted snapshots", () => {
  const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
    onnotice: () => {},
  });
  const app = postgres(process.env.TEST_DATABASE_URL!, { onnotice: () => {} });
  afterAll(async () => {
    await app.end();
    await admin.end();
  });
  it("round trips reviewed authority, rejects operator self-promotion and malformed provenance", async () => {
    const reviewer = randomUUID();
    const operator = randomUUID();
    await db.forWorkspace(ws, async () => {});
    await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"}),(${operator},${operator + "@example.test"})`;
    await admin`insert into memberships(workspace_id,user_id,role) values(${ws},${reviewer},'reviewer'),(${ws},${operator},'operator')`;
    const authority = {
      schemaVersion: 1 as const,
      domain: "example.test",
      subject: { kind: "producer" as const, name: "Fixture Estate" },
      proofUrl: "https://example.test/proof",
      proofDigest: "a".repeat(64),
      verifiedAt: new Date().toISOString(),
      expiresAt: "2027-01-01T00:00:00.000Z",
      revokedAt: null,
      verifierId: reviewer,
    };
    await db.forWorkspace(ws, async (r) => {
      await expect(
        r.wineEnrichment.recordReviewedAuthority(operator, {
          ...authority,
          verifierId: operator,
        }),
      ).rejects.toThrow("reviewer");
      await expect(
        r.wineEnrichment.recordReviewedAuthority(reviewer, {
          ...authority,
          proofDigest: "bad",
        }),
      ).rejects.toThrow();
      await r.wineEnrichment.recordReviewedAuthority(reviewer, authority);
      expect(await r.wineEnrichment.readAuthorities()).toEqual([authority]);
    });
    await db.forWorkspace(`other-${randomUUID()}`, async (r) => {
      await expect(
        r.wineEnrichment.recordReviewedAuthority(reviewer, authority),
      ).rejects.toThrow("reviewer");
      expect(await r.wineEnrichment.readAuthorities()).toEqual([]);
    });
  });
  it("freezes versioned trusted context and supports wine AI ledger names", async () => {
    const { wineIdentity } = await import("@wukong/core");
    await db.forWorkspace(ws, async (r) => {
      const operation = await run(r);
      const context = {
        schemaVersion: 1 as const,
        policyVersion: "v1",
        identity: wineIdentity(),
        authorities: [],
        supports: [],
        reliableSourceIds: [],
        trustedObservationSourceIds: [],
        acceptedPremises: [],
        verifiedAliases: [],
      };
      const snapshot = {
        runId: operation.id,
        contextKey: "verification",
        inputDigest: "identity-input",
        context,
      };
      await r.wineEnrichment.saveTrustedContext(snapshot);
      expect(
        await r.wineEnrichment.readTrustedContext(
          operation.id,
          "verification",
          "identity-input",
        ),
      ).toEqual(context);
      expect(
        await r.wineEnrichment.readTrustedContext(
          operation.id,
          "verification",
          "stale",
        ),
      ).toBeNull();
      await expect(
        r.wineEnrichment.saveTrustedContext({
          ...snapshot,
          context: { ...context, policyVersion: "changed" },
        }),
      ).rejects.toThrow("immutable");
      await expect(
        r.wineEnrichment.saveTrustedContext({
          ...snapshot,
          inputDigest: "changed",
        }),
      ).rejects.toThrow("immutable");
      expect(
        await r.aiRuns.beginInvocation({
          listingId: operation.listingId,
          pipelineRunId: operation.id,
          task: "wine_verification",
          stage: "verification",
          callOrdinal: 1,
          provider: "fake",
          model: "fake",
          promptVersion: "v1",
        }),
      ).toEqual({ claimed: true });
    });
  });
  it("enforces RLS without repository predicates and database terminal guards", async () => {
    const operationId = await db.forWorkspace(ws, async (r) => {
      const operation = await run(r);
      await r.wineEnrichment.claimStage({
        runId: operation.id,
        stage: "extraction",
        inputDigest: "a",
        dependencyDigest: "b",
      });
      await r.wineEnrichment.finishStage({
        runId: operation.id,
        stage: "extraction",
        inputDigest: "a",
        dependencyDigest: "b",
        state: "succeeded",
        output: { schemaVersion: 1 },
        updatedAt: new Date().toISOString(),
      });
      return operation.id;
    });
    await app.begin(async (tx) => {
      await tx`select set_config('app.workspace_id',${"other-" + randomUUID()},true)`;
      expect(
        await tx`select * from wine_stages where run_id=${operationId}`,
      ).toHaveLength(0);
    });
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`update wine_stages set output='{}'::jsonb where run_id=${operationId}`;
      }),
    ).rejects.toThrow("immutable");
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${"other-" + randomUUID()},true)`;
        await tx`insert into wine_stages(workspace_id,run_id,stage,input_digest,dependency_digest) values(${ws},${operationId},'generation','a','b')`;
      }),
    ).rejects.toThrow("row-level security");
  });
  it("replays SQL twice preserving rows and detects runtime UPDATE grant drift", async () => {
    const before = await admin`select count(*)::int n from wine_stages`;
    const migration = await readFile(
      new URL("../../drizzle/0041_wine_enrichment.sql", import.meta.url),
      "utf8",
    );
    await admin.unsafe(migration);
    await admin.unsafe(migration);
    expect(await admin`select count(*)::int n from wine_stages`).toEqual(
      before,
    );
    await admin`revoke update on wine_stages from wukong_app`;
    try {
      expect((await db.inspectWineEnrichmentCompatibility()).ready).toBe(false);
    } finally {
      await admin`grant update on wine_stages to wukong_app`;
    }
    expect((await db.inspectWineEnrichmentCompatibility()).ready).toBe(true);
  });
});

describe("section snapshots and credit edge cases", () => {
  const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
    onnotice: () => {},
  });
  const app = postgres(process.env.TEST_DATABASE_URL!, { onnotice: () => {} });
  afterAll(async () => {
    await admin.end();
    await app.end();
  });
  it("persists version-linked sections, rejects another listing and preserves content", async () => {
    const operations = await db.forWorkspace(ws, async (r) => [
      await run(r),
      await run(r),
    ]);
    const first = operations[0]!;
    const other = operations[1]!;
    const version = randomUUID();
    await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${version},${ws},${first.listingId},1,'{}','fixture')`;
    const content = {
      title: { en: "Fixture", "zh-Hant": "合成" },
      sections: [],
      seo: {
        title: { en: "Fixture", "zh-Hant": "合成" },
        description: { en: "Fixture", "zh-Hant": "合成" },
      },
      tags: [],
    };
    await db.forWorkspace(ws, async (r) => {
      const input = {
        runId: first.id,
        listingId: first.listingId,
        versionId: version,
        content,
      };
      await r.wineEnrichment.saveSections(input);
      expect(await r.wineEnrichment.readSections(first.id, version)).toEqual(
        content,
      );
      await expect(
        r.wineEnrichment.saveSections({
          ...input,
          content: { ...content, tags: ["changed"] },
        }),
      ).rejects.toThrow("immutable");
      await expect(
        r.wineEnrichment.saveSections({ ...input, runId: other.id }),
      ).rejects.toThrow("mismatch");
    });
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`insert into wine_section_snapshots(workspace_id,run_id,listing_id,version_id,payload) values(${ws},${other.id},${first.listingId},${version},'{"schemaVersion":1}')`;
      }),
    ).rejects.toThrow("foreign key");
  });
  it("database rejects unversioned evidence payloads", async () => {
    const operation = await db.forWorkspace(ws, run);
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`insert into wine_evidence(workspace_id,run_id,source_id,payload) values(${ws},${operation.id},${randomUUID()},'{}')`;
      }),
    ).rejects.toThrow("check constraint");
  });
  it("settles actual integer usage and prevents new calls after releasing the unused slots", async () => {
    await db.forWorkspace(`credits-${randomUUID()}`, async (r) => {
      const operation = await run(r);
      const reservation = {
        pipelineRunId: operation.id,
        reservedCredits: 5,
        workspaceCapCredits: 5,
        policyVersion: "v1",
      };
      await r.searchBudgetReservations.reserve(reservation);
      await expect(
        r.searchBudgetReservations.reserve({
          ...reservation,
          policyVersion: "v2",
        }),
      ).rejects.toThrow("immutable");
      const call = {
        runId: operation.id,
        slot: "advanced_1" as const,
        maximumCredits: 2,
        requestDigest: "measured",
      };
      expect(await r.wineEnrichment.beginSearchCall(call)).toBe(true);
      expect(
        await r.wineEnrichment.finishSearchCall({
          ...call,
          credits: 2,
          status: "succeeded",
        }),
      ).toBe(true);
      expect(
        await r.searchBudgetReservations.settleFromCalls(operation.id),
      ).toBe("settled");
      expect(
        await r.wineEnrichment.beginSearchCall({
          ...call,
          slot: "basic_1",
          maximumCredits: 1,
        }),
      ).toBe(false);
      const next = await run(r);
      expect(
        (
          await r.searchBudgetReservations.reserve({
            pipelineRunId: next.id,
            reservedCredits: 3,
            workspaceCapCredits: 5,
            policyVersion: "v1",
          })
        ).accepted,
      ).toBe(true);
    });
  });
});

describe("review fixes: null-safe ledgers and security definitions", () => {
  const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
    onnotice: () => {},
  });
  const app = postgres(process.env.TEST_DATABASE_URL!, { onnotice: () => {} });
  afterAll(async () => {
    await admin.end();
    await app.end();
  });
  it.each(["succeeded", "failed"])(
    "rejects missing measured credits for %s at repository and SQL boundaries",
    async (status) => {
      const operation = await db.forWorkspace(ws, async (r) => {
        const op = await run(r);
        await r.searchBudgetReservations.reserve({
          pipelineRunId: op.id,
          reservedCredits: 5,
          workspaceCapCredits: 10000,
          policyVersion: "v1",
        });
        await r.wineEnrichment.beginSearchCall({
          runId: op.id,
          slot: "basic_1",
          maximumCredits: 1,
          requestDigest: "null-probe",
        });
        return op;
      });
      await expect
        .soft(
          db.forWorkspace(ws, async (r) => {
            await r.wineEnrichment.finishSearchCall({
              runId: operation.id,
              slot: "basic_1",
              maximumCredits: 1,
              requestDigest: "null-probe",
              credits: null,
              status,
            });
            throw new Error("probe unexpectedly accepted");
          }),
        )
        .rejects.toThrow("credits");
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id',${ws},true)`;
          await tx`update wine_search_calls set status=${status},credits=null where workspace_id=${ws} and run_id=${operation.id}`;
          throw new Error("probe unexpectedly accepted");
        }),
      ).rejects.toThrow("check constraint");
    },
  );
  it("rejects settled reservation without measured credits in raw runtime SQL", async () => {
    const op = await db.forWorkspace(ws, async (r) => {
      const op = await run(r);
      await r.searchBudgetReservations.reserve({
        pipelineRunId: op.id,
        reservedCredits: 5,
        workspaceCapCredits: 10000,
        policyVersion: "v1",
      });
      return op;
    });
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`update search_budget_reservations set state='settled',settled_credits=null where workspace_id=${ws} and pipeline_run_id=${op.id}`;
        throw new Error("probe unexpectedly accepted");
      }),
    ).rejects.toThrow("check constraint");
  });
  it.each([
    "wine_evidence",
    "wine_section_snapshots",
    "wine_source_authorities",
    "wine_trusted_contexts",
  ])("rejects null and string schemaVersion in %s", async (table) => {
    const op = await db.forWorkspace(ws, run);
    const version = randomUUID();
    await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${version},${ws},${op.listingId},1,'{}','fixture')`;
    for (const schemaVersion of [null, "1"]) {
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id',${ws},true)`;
          if (table === "wine_evidence")
            await tx`insert into wine_evidence(workspace_id,run_id,source_id,payload) values(${ws},${op.id},${randomUUID()},${tx.json({ schemaVersion })})`;
          if (table === "wine_section_snapshots")
            await tx`insert into wine_section_snapshots(workspace_id,run_id,listing_id,version_id,payload) values(${ws},${op.id},${op.listingId},${version},${tx.json({ schemaVersion })})`;
          if (table === "wine_source_authorities")
            await tx`insert into wine_source_authorities(workspace_id,reviewer_id,payload) values(${ws},'fixture',${tx.json({ schemaVersion })})`;
          if (table === "wine_trusted_contexts")
            await tx`insert into wine_trusted_contexts(workspace_id,run_id,context_key,input_digest,payload) values(${ws},${op.id},'fixture','fixture',${tx.json({ schemaVersion })})`;
          throw new Error("probe unexpectedly accepted");
        }),
      ).rejects.toThrow("check constraint");
    }
  });
  it.each([
    "FOR ALL TO wukong_app USING(true) WITH CHECK(true)",
    "FOR ALL TO PUBLIC USING (workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),''))) WITH CHECK (workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')))",
    "FOR SELECT TO wukong_app USING (workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')))",
  ])("detects policy definition drift: %s", async (definition) => {
    await admin`drop policy wine_workspace_policy on wine_evidence`;
    try {
      await admin.unsafe(
        `create policy wine_workspace_policy on wine_evidence ${definition}`,
      );
      expect((await db.inspectWineEnrichmentCompatibility()).ready).toBe(false);
    } finally {
      await admin`drop policy if exists wine_workspace_policy on wine_evidence`;
      await admin`create policy wine_workspace_policy on wine_evidence for all to wukong_app using (workspace_id=(select nullif(current_setting('app.workspace_id',true),''))) with check (workspace_id=(select nullif(current_setting('app.workspace_id',true),'')))`;
    }
  });
  it.each(["ineffective", "misbound"])(
    "detects %s constraint despite matching name",
    async (variant) => {
      const original =
        await admin`select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='public.wine_search_calls'::regclass and conname='wine_calls_units_check'`;
      await admin`alter table wine_search_calls drop constraint wine_calls_units_check`;
      try {
        if (variant === "ineffective")
          await admin`alter table wine_search_calls add constraint wine_calls_units_check check(true)`;
        else
          await admin`alter table wine_stages add constraint wine_calls_units_check check(true)`;
        expect((await db.inspectWineEnrichmentCompatibility()).ready).toBe(
          false,
        );
      } finally {
        await admin`alter table wine_search_calls drop constraint if exists wine_calls_units_check`;
        await admin`alter table wine_stages drop constraint if exists wine_calls_units_check`;
        await admin.unsafe(
          `alter table wine_search_calls add constraint wine_calls_units_check ${original[0]!.definition}`,
        );
      }
    },
  );
  it.each([
    "BEFORE UPDATE OR DELETE ON wine_stages FOR EACH ROW EXECUTE FUNCTION guard_immutable_enrichment_suggestion()",
    "AFTER UPDATE ON wine_stages FOR EACH ROW EXECUTE FUNCTION guard_wine_terminal()",
  ])("detects trigger function or event drift: %s", async (definition) => {
    await admin`drop trigger wine_immutable_guard on wine_stages`;
    try {
      await admin.unsafe(`create trigger wine_immutable_guard ${definition}`);
      expect((await db.inspectWineEnrichmentCompatibility()).ready).toBe(false);
    } finally {
      await admin`drop trigger if exists wine_immutable_guard on wine_stages`;
      await admin`create trigger wine_immutable_guard before update or delete on wine_stages for each row execute function guard_wine_terminal()`;
    }
  });
});

describe("additional permissive policy drift", () => {
  it("rejects an extra permissive policy even when the expected policy remains correct", async () => {
    const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
      onnotice: () => {},
    });
    try {
      await admin`create policy wine_extra_permissive on wine_evidence for all to wukong_app using(true) with check(true)`;
      expect((await db.inspectWineEnrichmentCompatibility()).ready).toBe(false);
    } finally {
      await admin`drop policy if exists wine_extra_permissive on wine_evidence`;
      await admin.end();
    }
    expect((await db.inspectWineEnrichmentCompatibility()).ready).toBe(true);
  });
});

describe("reviewed source reliability persistence", () => {
  it("round trips reviewer-only canonical reliability and append-only revocation", async () => {
    const { resolveWineSourceReliability, resolveWineSourceAuthority } =
      await import("@wukong/core");
    const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
      onnotice: () => {},
    });
    const reliabilityWs = `wine-reliability-${randomUUID()}`,
      otherWs = `wine-reliability-other-${randomUUID()}`;
    const reviewer = randomUUID(),
      operator = randomUUID();
    try {
      await db.forWorkspace(reliabilityWs, async (r) => {
        await run(r);
      });
      await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"}),(${operator},${operator + "@example.test"})`;
      await admin`insert into memberships(workspace_id,user_id,role) values(${reliabilityWs},${reviewer},'reviewer'),(${reliabilityWs},${operator},'operator')`;
      const designation = {
        schemaVersion: 1 as const,
        domain: "example.test",
        subject: { kind: "reliable_source" as const, name: "example.test" },
        proofUrl: "https://example.test/reliability-review",
        proofDigest: "b".repeat(64),
        verifiedAt: "2026-09-01T00:00:00Z",
        expiresAt: "2027-01-01T00:00:00Z",
        revokedAt: null,
        verifierId: reviewer,
      };
      await db.forWorkspace(reliabilityWs, async (r) => {
        await r.wineEnrichment.recordReviewedAuthority(reviewer, designation);
        const records = await r.wineEnrichment.readAuthorities();
        expect(records).toEqual([designation]);
        expect(
          resolveWineSourceReliability(
            webEvidence(),
            records,
            "2026-09-16T00:00:00Z",
          ),
        ).toEqual(designation);
        expect(
          resolveWineSourceAuthority(
            webEvidence(),
            { kind: "producer", name: "example.test" },
            records,
            "2026-09-16T00:00:00Z",
          ),
        ).toBeNull();
      });
      await db.forWorkspace(reliabilityWs, async (r) => {
        await expect(
          r.wineEnrichment.recordReviewedAuthority(operator, {
            ...designation,
            verifierId: operator,
          }),
        ).rejects.toThrow("reviewer");
        await expect(
          r.wineEnrichment.recordReviewedAuthority(reviewer, {
            ...designation,
            verifierId: operator,
          }),
        ).rejects.toThrow("reviewer");
        await expect(
          r.wineEnrichment.recordReviewedAuthority(reviewer, {
            ...designation,
            subject: { ...designation.subject, name: "Store Name" },
          }),
        ).rejects.toThrow();
        await expect(
          r.wineEnrichment.recordReviewedAuthority(reviewer, {
            ...designation,
            proofDigest: "bad",
          }),
        ).rejects.toThrow();
      });
      await db.forWorkspace(otherWs, async (r) => {
        await expect(
          r.wineEnrichment.recordReviewedAuthority(reviewer, designation),
        ).rejects.toThrow("reviewer");
        expect(await r.wineEnrichment.readAuthorities()).toEqual([]);
      });
      const revocation = { ...designation, revokedAt: "2026-09-15T00:00:00Z" };
      await db.forWorkspace(reliabilityWs, async (r) => {
        await r.wineEnrichment.recordReviewedAuthority(reviewer, revocation);
      });
      await db.forWorkspace(reliabilityWs, async (r) => {
        const records = await r.wineEnrichment.readAuthorities();
        expect(records).toEqual([designation, revocation]);
        expect(
          resolveWineSourceReliability(
            webEvidence(),
            records,
            "2026-09-16T00:00:00Z",
          ),
        ).toBeNull();
      });
    } finally {
      await admin.end();
    }
  });
});
