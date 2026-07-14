import { defineConfig, devices } from "@playwright/test";

const enabled = process.env.PLAYWRIGHT_E2E === "1";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:49217";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: enabled && !process.env.PLAYWRIGHT_BASE_URL ? {
    command: "node tests/e2e/fake-pilot-server.mjs",
    url: `${baseURL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { ...process.env, PORT: "49217", AI_PROVIDER: "fake", SHOPLINE_ADAPTER: "mock" },
  } : undefined,
});
