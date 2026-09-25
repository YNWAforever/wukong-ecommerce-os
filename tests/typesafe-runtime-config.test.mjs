import assert from "node:assert/strict";
import test from "node:test";

import {
  readTypeSafeRuntimeConfig,
  typeSafeSecretPolicy,
} from "../scripts/typesafe-runtime-config.mjs";
import { verifyExactSecretNames } from "../scripts/verify-cloudflare-secrets.mjs";

const base = ["BASE_SECRET", "BASE_SECRET"];

test("defaults verification off and allows a retained API key", () => {
  const runtime = readTypeSafeRuntimeConfig({});
  const policy = typeSafeSecretPolicy(base, runtime.mode);
  assert.deepEqual(runtime, {
    mode: "off",
    vars: { TYPESAFE_VERIFICATION_MODE: "off" },
  });
  assert.deepEqual(policy, {
    required: ["BASE_SECRET"],
    optional: ["TYPESAFE_API_KEY"],
  });
  assert.doesNotThrow(() =>
    verifyExactSecretNames(
      policy.required,
      ["BASE_SECRET", "TYPESAFE_API_KEY"],
      policy.optional,
    ),
  );
});

test("advisory mode renders the pinned model and requires its API key", () => {
  const runtime = readTypeSafeRuntimeConfig({
    TYPESAFE_VERIFICATION_MODE: "advisory",
    TYPESAFE_MODEL: "  jev-1.13.0  ",
  });
  const policy = typeSafeSecretPolicy(base, runtime.mode);
  assert.deepEqual(runtime, {
    mode: "advisory",
    vars: {
      TYPESAFE_VERIFICATION_MODE: "advisory",
      TYPESAFE_MODEL: "jev-1.13.0",
    },
  });
  assert.deepEqual(policy, {
    required: ["BASE_SECRET", "TYPESAFE_API_KEY"],
    optional: [],
  });
  assert.throws(
    () =>
      verifyExactSecretNames(policy.required, ["BASE_SECRET"], policy.optional),
    /missing: TYPESAFE_API_KEY/,
  );
});

test("rejects invalid modes and missing or invalid advisory models", () => {
  assert.throws(
    () => readTypeSafeRuntimeConfig({ TYPESAFE_VERIFICATION_MODE: "enabled" }),
    /invalid TYPESAFE_VERIFICATION_MODE/,
  );
  for (const model of [
    undefined,
    "",
    "jev latest",
    "gpt-5",
    `jev-${"x".repeat(81)}`,
  ]) {
    assert.throws(
      () =>
        readTypeSafeRuntimeConfig({
          TYPESAFE_VERIFICATION_MODE: "advisory",
          TYPESAFE_MODEL: model,
        }),
      /TYPESAFE_MODEL is required/,
    );
  }
});

test("still rejects unrelated unexpected secrets", () => {
  const policy = typeSafeSecretPolicy(base, "off");
  assert.throws(
    () =>
      verifyExactSecretNames(
        policy.required,
        ["BASE_SECRET", "OTHER_SECRET"],
        policy.optional,
      ),
    /unexpected: OTHER_SECRET/,
  );
});
