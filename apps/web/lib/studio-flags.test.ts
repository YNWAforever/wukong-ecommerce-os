import { describe, expect, it } from "vitest";

import {
  isStudioAiEnabled,
  isStudioDefaultHome,
  isStudioEnabled,
  isStudioFeatureFlagOn,
  isStudioMcpServerEnabled,
  type StudioFlagSettings,
} from "./studio-flags.js";

/**
 * `process.env`-shaped input. The flag parsers accept `NodeJS.ProcessEnv`, so
 * the tests build minimal environments through this helper instead of
 * mutating the real process environment.
 */
function env(
  values: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

const ENABLED_SETTINGS: StudioFlagSettings = {
  enabled: true,
  defaultHome: false,
  ai: null,
};

const ALL_ON_SETTINGS: StudioFlagSettings = {
  enabled: true,
  defaultHome: true,
  ai: {
    provider: "openrouter",
    model: "synthetic-model",
    pricingVersion: "synthetic",
    maxInputTokens: 1,
    inputUsdPerMillion: "0",
    outputUsdPerMillion: "0",
    maxOutputTokens: 1,
  },
};

describe("isStudioFeatureFlagOn", () => {
  it("reads only the deployment flag, so callers can skip the settings read while Studio is off", () => {
    expect(
      isStudioFeatureFlagOn(env({ CONVERSATION_STUDIO_ENABLED: "true" })),
    ).toBe(true);
    expect(isStudioFeatureFlagOn(env())).toBe(false);
    for (const value of ["1", "true ", "TRUE", "yes", "false"]) {
      expect(
        isStudioFeatureFlagOn(env({ CONVERSATION_STUDIO_ENABLED: value })),
      ).toBe(false);
    }
  });
});

describe("isStudioEnabled", () => {
  it("is true only when the env flag is exactly 'true' and the workspace row is enabled", () => {
    expect(
      isStudioEnabled(
        env({ CONVERSATION_STUDIO_ENABLED: "true" }),
        ENABLED_SETTINGS,
      ),
    ).toBe(true);
  });

  it.each([
    ["unset", undefined],
    ["'1'", "1"],
    ["'true ' with trailing space", "true "],
    ["' true' with leading space", " true"],
    ["'TRUE'", "TRUE"],
    ["'yes'", "yes"],
    ["'false'", "false"],
  ])("is false when the env flag is %s", (_label, value) => {
    expect(
      isStudioEnabled(env({ CONVERSATION_STUDIO_ENABLED: value }), {
        enabled: true,
        defaultHome: false,
        ai: null,
      }),
    ).toBe(false);
  });

  it.each([
    ["null settings (no workspace row)", null],
    [
      "a disabled workspace row",
      { enabled: false, defaultHome: true, ai: null },
    ],
  ] as const)(
    "is false for %s even with the env flag on",
    (_label, settings) => {
      expect(
        isStudioEnabled(env({ CONVERSATION_STUDIO_ENABLED: "true" }), settings),
      ).toBe(false);
    },
  );

  it("does not read unrelated flags", () => {
    expect(
      isStudioEnabled(
        env({
          CONVERSATION_STUDIO_AI_ENABLED: "true",
          CONVERSATION_STUDIO_DEFAULT_HOME: "true",
          STUDIO_MCP_SERVER_ENABLED: "true",
        }),
        ALL_ON_SETTINGS,
      ),
    ).toBe(false);
  });
});

describe("isStudioAiEnabled", () => {
  it("is true only with the env flag on and a configured workspace model", () => {
    expect(
      isStudioAiEnabled(
        env({ CONVERSATION_STUDIO_AI_ENABLED: "true" }),
        ALL_ON_SETTINGS,
      ),
    ).toBe(true);
  });

  it("is false when no model is configured (ai is null)", () => {
    expect(
      isStudioAiEnabled(
        env({ CONVERSATION_STUDIO_AI_ENABLED: "true" }),
        ENABLED_SETTINGS,
      ),
    ).toBe(false);
  });

  it("is false when the settings row is missing", () => {
    expect(
      isStudioAiEnabled(env({ CONVERSATION_STUDIO_AI_ENABLED: "true" }), null),
    ).toBe(false);
  });

  it.each(["1", "true ", "yes", "FALSE"])(
    "is false for the malformed env value %j",
    (value) => {
      expect(
        isStudioAiEnabled(env({ CONVERSATION_STUDIO_AI_ENABLED: value }), {
          enabled: true,
          defaultHome: false,
          ai: { model: "x" },
        }),
      ).toBe(false);
    },
  );
});

describe("isStudioDefaultHome", () => {
  it("is true only when the flag, Studio and the workspace default-home opt-in all agree", () => {
    expect(
      isStudioDefaultHome(
        env({
          CONVERSATION_STUDIO_ENABLED: "true",
          CONVERSATION_STUDIO_DEFAULT_HOME: "true",
        }),
        ALL_ON_SETTINGS,
      ),
    ).toBe(true);
  });

  it("is false when the workspace did not opt in", () => {
    expect(
      isStudioDefaultHome(
        env({
          CONVERSATION_STUDIO_ENABLED: "true",
          CONVERSATION_STUDIO_DEFAULT_HOME: "true",
        }),
        ENABLED_SETTINGS,
      ),
    ).toBe(false);
  });

  it("is false when Studio itself is off even if default-home is requested", () => {
    expect(
      isStudioDefaultHome(
        env({ CONVERSATION_STUDIO_DEFAULT_HOME: "true" }),
        ALL_ON_SETTINGS,
      ),
    ).toBe(false);
    expect(
      isStudioDefaultHome(
        env({
          CONVERSATION_STUDIO_ENABLED: "true",
          CONVERSATION_STUDIO_DEFAULT_HOME: "true",
        }),
        { enabled: false, defaultHome: true, ai: null },
      ),
    ).toBe(false);
  });

  it("is false when the default-home value is malformed", () => {
    expect(
      isStudioDefaultHome(
        env({
          CONVERSATION_STUDIO_ENABLED: "true",
          CONVERSATION_STUDIO_DEFAULT_HOME: "yes",
        }),
        ALL_ON_SETTINGS,
      ),
    ).toBe(false);
  });
});

describe("isStudioMcpServerEnabled", () => {
  it("is true only when the MCP flag and Studio are both on", () => {
    expect(
      isStudioMcpServerEnabled(
        env({
          CONVERSATION_STUDIO_ENABLED: "true",
          STUDIO_MCP_SERVER_ENABLED: "true",
        }),
        ENABLED_SETTINGS,
      ),
    ).toBe(true);
  });

  it("is false when Studio is off, even with the MCP flag on", () => {
    expect(
      isStudioMcpServerEnabled(
        env({ STUDIO_MCP_SERVER_ENABLED: "true" }),
        ENABLED_SETTINGS,
      ),
    ).toBe(false);
  });

  it("is false for a malformed MCP flag", () => {
    expect(
      isStudioMcpServerEnabled(
        env({
          CONVERSATION_STUDIO_ENABLED: "true",
          STUDIO_MCP_SERVER_ENABLED: "1",
        }),
        ENABLED_SETTINGS,
      ),
    ).toBe(false);
  });
});
