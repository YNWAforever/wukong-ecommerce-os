import { defineConfig } from "vitest/config";

/** Root integration gate; service URLs are supplied by the local environment/CI. */
export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.integration.test.ts",
      "apps/**/src/**/*.integration.test.ts",
      // apps/web has no `src` dir (Next.js App Router) -- its route-level
      // integration tests live next to the route under `app/api/**` instead.
      "apps/web/app/**/*.integration.test.ts",
    ],
    // Integration suites share one PostgreSQL database and mutate shared tables;
    // serialize files to avoid relation-lock deadlocks in local and CI runs.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
