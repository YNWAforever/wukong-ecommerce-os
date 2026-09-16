import { describe, expect, it } from "vitest";

import {
  assertSchemaCompatibility,
  inspectSchemaCompatibility,
  type SchemaCapabilityRow,
} from "./schema-compatibility.js";

const compatible: SchemaCapabilityRow = {
  outbox_table: true,
  outbox_rls_enabled: true,
  outbox_rls_forced: true,
  outbox_workspace_policy: true,
  outbox_app_privileges: true,
  sweeper_function: true,
  sweeper_security_definer: true,
  sweeper_public_execute_revoked: true,
  sweeper_app_execute_granted: true,
  sweeper_orders_oldest_first: true,
  sweeper_bounds_attempts: true,
  export_source_attestation: true,
  export_attestation_nullable: true,
  export_attestation_no_default: true,
  export_attestation_array_check: true,
  import_guard_function: true,
  import_guard_accepts_legacy_attestation: true,
  import_guard_accepts_digest_attestation: true,
  import_guard_rejects_missing_attestation: true,
  import_guard_public_execute_revoked: true,
  import_guard_app_execute_granted: true,
  review_field_records: true,
  review_field_records_nullable: true,
  review_field_records_no_default: true,
  review_field_records_object_check: true,
};

describe("schema compatibility readiness", () => {
  it("returns a bounded capability report without exposing database internals", async () => {
    const report = await inspectSchemaCompatibility(async () => [compatible]);

    expect(report).toEqual({
      version: "t01-0023-0027-v1",
      ready: true,
      missing: [],
    });
  });

  it("names missing capabilities and blocks activation", async () => {
    const report = await inspectSchemaCompatibility(async () => [
      { ...compatible, sweeper_app_execute_granted: false },
    ]);

    expect(report.ready).toBe(false);
    expect(report.missing).toEqual(["0024.sweeper_app_execute_granted"]);
    await expect(
      assertSchemaCompatibility(async () => [
        { ...compatible, sweeper_app_execute_granted: false },
      ]),
    ).rejects.toThrow(
      "Database setup is incomplete for this operation (t01-0023-0027-v1)",
    );
  });

  it("fails closed when the catalog query does not return exactly one row", async () => {
    await expect(inspectSchemaCompatibility(async () => [])).resolves.toEqual({
      version: "t01-0023-0027-v1",
      ready: false,
      missing: ["catalog.unavailable"],
    });
  });
});
