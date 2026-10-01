import { describe, expect, it } from "vitest";
import { inspectListingReadCompatibility } from "./listing-read-compatibility.js";
describe("listing read deployment preflight", () => {
  const ready = {
    source_import_column: true,
    source_digest_column: true,
    source_binding_fk: true,
    versions_rls: true,
    app_can_read_versions: true,
    runtime_role_safe: true,
    effective_runtime_role: true,
  };
  it("reports the missing source binding without pretending an incomplete catalog is ready", async () => {
    const result = await inspectListingReadCompatibility(async () => [
      { ...ready, source_import_column: false },
    ]);
    expect(result).toEqual({
      version: "listing-read-0046-v1",
      ready: false,
      missing: ["0046.source_import_column"],
    });
    expect((await inspectListingReadCompatibility(async () => [])).ready).toBe(
      false,
    );
  });
  it("refuses a bypass-RLS runtime role or absent app grant", async () => {
    const result = await inspectListingReadCompatibility(async () => [
      { ...ready, runtime_role_safe: false, app_can_read_versions: false },
    ]);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      "0046.app_can_read_versions",
      "0046.runtime_role_safe",
    ]);
  });
  it("reports ready only when all schema and privilege predicates are true", async () => {
    expect(await inspectListingReadCompatibility(async () => [ready])).toEqual({
      version: "listing-read-0046-v1",
      ready: true,
      missing: [],
    });
  });
  it("refuses credentials for another effective role even when wukong_app is safe", async () => {
    expect(
      await inspectListingReadCompatibility(async () => [
        { ...ready, effective_runtime_role: false },
      ]),
    ).toMatchObject({ ready: false, missing: ["0046.effective_runtime_role"] });
  });
  it("propagates catalog permission and connection failures", async () => {
    const fault = Object.assign(new Error("private SQL"), { code: "42501" });
    await expect(
      inspectListingReadCompatibility(async () => {
        throw fault;
      }),
    ).rejects.toBe(fault);
  });
});
