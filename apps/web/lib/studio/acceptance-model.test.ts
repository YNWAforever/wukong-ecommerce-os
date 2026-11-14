import { describe, expect, it } from "vitest";
import { studioAcceptanceModelFactory } from "./acceptance-model";
import { createFakeStudio } from "./test-fakes";
const isolated: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  PLAYWRIGHT_E2E: "1",
  STUDIO_GUIDED_ACCEPTANCE: "1",
  WUKONG_STUDIO_ACCEPTANCE_FAKE_MODEL: "1",
  BETTER_AUTH_URL: "http://127.0.0.1:49300",
  DATABASE_URL: "postgres://wukong_app@127.0.0.1:54329/wukong",
};
describe("isolated Studio browser model", () => {
  it.each([
    {},
    { PLAYWRIGHT_E2E: "0" },
    { STUDIO_GUIDED_ACCEPTANCE: "0" },
    { WUKONG_STUDIO_ACCEPTANCE_FAKE_MODEL: "0" },
    { BETTER_AUTH_URL: "https://production.example" },
    { DATABASE_URL: "postgres://wukong_app@database.example:54329/wukong" },
    { DATABASE_URL: "postgres://wukong_app@127.0.0.1:54329/other" },
    { DATABASE_URL: "postgres://other@127.0.0.1:54329/wukong" },
  ])("refuses a missing or non-isolated guard: %j", (changed) => {
    const env: NodeJS.ProcessEnv =
      Object.keys(changed).length === 0
        ? { NODE_ENV: "production" }
        : { ...isolated, ...changed };
    expect(studioAcceptanceModelFactory(env)).toBeUndefined();
  });
  it("binds only the seeded workspace and reviewed model policy without a provider key", async () => {
    const settings = await createFakeStudio({
      settings: {
        workspaceId: "ws_studio_browser_e2e",
        ai: {
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          pricingVersion: "opencode-go-2026-11",
          maxInputTokens: 1048576,
          inputUsdPerMillion: "0.3",
          outputUsdPerMillion: "1.2",
          maxOutputTokens: 4096,
        },
      },
    }).repos.studio.settings.get();
    const factory = studioAcceptanceModelFactory(isolated)!;
    expect(factory(settings)).not.toBeNull();
    expect(factory({ ...settings, workspaceId: "other" })).toBeNull();
    expect(factory({ ...settings, ai: null })).toBeNull();
  });
});
