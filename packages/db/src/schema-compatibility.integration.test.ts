import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { loadSqlMigrations } from "./migrations.js";
import {
  inspectSchemaCompatibility,
  type SchemaCapabilityRow,
} from "./schema-compatibility.js";

const url = process.env.T01_REHEARSAL_DATABASE_ADMIN_URL;
const enabled = Boolean(url) && process.env.T01_REHEARSAL_DISPOSABLE === "yes";

if (enabled) {
  const target = new URL(url!);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/t01_compatibility"
  ) {
    throw new Error("Refusing non-isolated T01 rehearsal target");
  }
}

const admin = enabled
  ? postgres(url!, { max: 1, onnotice: () => undefined, prepare: false })
  : null;
const migrations = await loadSqlMigrations(
  new URL("../drizzle/", import.meta.url),
);

async function reset(): Promise<void> {
  const [target] = await admin!`select current_database() as name`;
  expect(target?.name).toBe("t01_compatibility");
  await admin!.unsafe(
    "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC",
  );
}

async function apply(names: (name: string) => boolean): Promise<void> {
  for (const migration of migrations.filter(({ name }) => names(name))) {
    await admin!.begin(async (transaction) => {
      await transaction.unsafe(migration.sql);
    });
  }
}

async function report() {
  return inspectSchemaCompatibility(async (sql) =>
    admin!.unsafe<SchemaCapabilityRow[]>(sql),
  );
}

afterAll(async () => {
  await admin?.end();
});

describe.skipIf(!enabled)("T01 disposable migration compatibility", () => {
  it("reaches readiness from an empty database and remains replay-safe", async () => {
    await reset();
    await apply(() => true);
    await expect(report()).resolves.toMatchObject({ ready: true, missing: [] });

    await admin!`insert into workspaces(id,name,profile) values('t01_physical_replay','T01 physical replay','{}')`;
    await admin!`insert into listing_drafts(id,workspace_id) values('22222222-2222-4222-8222-222222222222','t01_physical_replay')`;
    const [run] =
      await admin!`insert into listing_pipeline_runs(workspace_id,listing_id,active_version_sequence,idempotency_key,status) values('t01_physical_replay','22222222-2222-4222-8222-222222222222',0,'physical-replay','started') returning id`;
    await admin!`insert into ai_runs(workspace_id,listing_id,task,idempotency_key,provider,model,status,input,latency_ms,pipeline_run_id,stage,call_ordinal,usage_certainty,estimated_cost_usd) values('t01_physical_replay','22222222-2222-4222-8222-222222222222','extract','physical-replay-call','openai','test-model','started','{}',0,${run!.id},'extract',1,'unknown',null)`;

    await apply(() => true);
    await expect(report()).resolves.toMatchObject({ ready: true, missing: [] });
    const [physical] =
      await admin!`select status, estimated_cost_usd from ai_runs where idempotency_key='physical-replay-call'`;
    expect(physical).toMatchObject({
      status: "started",
      estimated_cost_usd: null,
    });
  });

  it("repairs the observed pre-0023 shape without inventing historical attestations", async () => {
    await reset();
    await apply((name) => name < "0023");
    await admin!`insert into workspaces(id,name,profile) values('t01_old_shape','T01 old shape','{}')`;
    await admin!`insert into export_attempts(workspace_id,idempotency_key,requested_by,manifest,row_count,spec_version) values('t01_old_shape','historical-export','synthetic','[]',0,'historical')`;

    await expect(report()).resolves.toMatchObject({ ready: false });
    await apply((name) => name >= "0023");
    await expect(report()).resolves.toMatchObject({ ready: true, missing: [] });

    const [historical] = await admin!`
      select source_attestation from export_attempts
      where workspace_id='t01_old_shape' and idempotency_key='historical-export'
    `;
    expect(historical?.source_attestation).toBeNull();
    await expect(
      admin!`update export_attempts set source_attestation='{}'::jsonb where workspace_id='t01_old_shape'`,
    ).rejects.toThrow(/export_attempts_source_attestation_is_array/);
  });
});
