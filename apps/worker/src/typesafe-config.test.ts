import { expect, it, vi } from "vitest";
import { createConfiguredVerifier } from "./typesafe-config.js";
import { listing, facts, evidence } from "./pipeline-test-support.js";
const input = { listing, facts, evidence, note: null };
it("defaults off even with credentials and never invokes factory", () => {
  const factory = vi.fn();
  expect(
    createConfiguredVerifier(
      { TYPESAFE_API_KEY: "secret", TYPESAFE_MODEL: "model" },
      factory,
    ),
  ).toBeUndefined();
  expect(
    createConfiguredVerifier({ TYPESAFE_VERIFICATION_MODE: "off" }, factory),
  ).toBeUndefined();
  expect(factory).not.toHaveBeenCalled();
});
it.each([
  { TYPESAFE_VERIFICATION_MODE: "advisory" },
  { TYPESAFE_VERIFICATION_MODE: "advisory", TYPESAFE_API_KEY: "secret" },
  { TYPESAFE_VERIFICATION_MODE: "advisory", TYPESAFE_MODEL: "model" },
  {
    TYPESAFE_VERIFICATION_MODE: "oops",
    TYPESAFE_API_KEY: "secret",
    TYPESAFE_MODEL: "model",
  },
])("fails closed on invalid config %j", async (config) => {
  const factory = vi.fn();
  expect(
    await createConfiguredVerifier(config, factory)!.verify(input),
  ).toMatchObject({
    outcome: "unavailable",
    reason: "configuration",
    usage: { requestAttempted: false },
  });
  expect(factory).not.toHaveBeenCalled();
});
it("constructs only explicitly configured advisory", () => {
  const verifier = { verify: vi.fn() };
  const factory = vi.fn(() => verifier);
  expect(
    createConfiguredVerifier(
      {
        TYPESAFE_VERIFICATION_MODE: "advisory",
        TYPESAFE_API_KEY: "secret",
        TYPESAFE_MODEL: "model",
      },
      factory,
    ),
  ).toBe(verifier);
  expect(factory).toHaveBeenCalledTimes(1);
});
