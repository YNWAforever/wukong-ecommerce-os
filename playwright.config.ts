import { defineConfig, devices } from "@playwright/test";

const enabled = process.env.PLAYWRIGHT_E2E === "1";
const authE2E = !enabled;
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ??
  (authE2E ? "http://127.0.0.1:49218" : "http://127.0.0.1:49217");

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.(ts|js|mjs)$/,
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: !process.env.PLAYWRIGHT_BASE_URL
    ? {
        command: enabled
          ? "node tests/e2e/fake-pilot-server.mjs"
          : "pnpm --filter @wukong/web dev --hostname 127.0.0.1 --port 49218",
        url: enabled ? `${baseURL}/health` : `${baseURL}/register`,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        env: enabled
          ? {
              ...process.env,
              PORT: "49217",
              AI_PROVIDER: "fake",
              SHOPLINE_ADAPTER: "mock",
            }
          : {
              ...process.env,
              DATABASE_URL:
                process.env.TEST_DATABASE_URL ??
                "postgres://wukong_app:wukong-app-local@127.0.0.1:54329/wukong",
              AUTH_SECRET:
                process.env.AUTH_SECRET ??
                "local-auth-e2e-secret-at-least-thirty-two-characters",
              AUTH_SMTP_URL:
                process.env.AUTH_SMTP_URL ?? "smtp://127.0.0.1:1026",
              AUTH_EMAIL_FROM:
                process.env.AUTH_EMAIL_FROM ??
                "Wukong Auth <auth@local.invalid>",
              BETTER_AUTH_URL: baseURL,
            },
      }
    : undefined,
});
