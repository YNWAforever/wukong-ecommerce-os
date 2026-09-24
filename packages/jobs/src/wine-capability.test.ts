import { describe, expect, it } from "vitest";
import * as capability from "./wine-capability.js";
const execution = {
  schemaVersion: 1,
  flowVersion: "wine-enrichment-v1",
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  contractVersion: "wine-contract@1",
  rulesVersion: "wine-grounding@1",
  maxOutputTokens: 4096,
  promptVersions: {
    extract: "wine-extract@1.0.0",
    verify: "wine-verify@1.0.0",
    generate: "wine-generate@1.0.0",
    check: "wine-check@1.0.0",
  },
};
export const fixture = () => ({
  schemaVersion: 1,
  execution,
  databaseSchemaVersion: "wine-enrichment-0042-v1",
  buildSha: "a".repeat(40),
  consumerSupported: false,
  goConfigured: true,
  tavilyConfigured: true,
  queueReady: true,
  databaseReady: true,
});
describe("wine capability interchange", () => {
  it("accepts diagnostic false support and rejects unknown metadata", () => {
    expect(capability.wineCapabilitySchema.parse(fixture())).toEqual(fixture());
    expect(
      capability.wineCapabilitySchema.safeParse({
        ...fixture(),
        secret: "oops",
      }).success,
    ).toBe(false);
  });
  it.each([
    { schemaVersion: 2 },
    { databaseSchemaVersion: "old" },
    { buildSha: "secret-marker" },
    { execution: { ...execution, model: "other" } },
    {
      execution: {
        ...execution,
        promptVersions: { ...execution.promptVersions, check: "old" },
      },
    },
    { execution: { ...execution, flowVersion: "other" } },
  ])("rejects incompatible metadata %j", (patch) => {
    expect(
      capability.wineCapabilitySchema.safeParse({ ...fixture(), ...patch })
        .success,
    ).toBe(false);
  });
});
