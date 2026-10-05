import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("Next pins Turbopack to the Wukong monorepo root", async () => {
  const configUrl = pathToFileURL(
    path.join(process.cwd(), "apps", "web", "next.config.mjs"),
  );
  const { default: config } = await import(configUrl.href);

  assert.equal(config.turbopack?.root, process.cwd());
  assert.equal(config.outputFileTracingRoot, process.cwd());
});

test("Next sends baseline security headers on every route", async () => {
  const configUrl = pathToFileURL(
    path.join(process.cwd(), "apps", "web", "next.config.mjs"),
  );
  const { default: config } = await import(configUrl.href);

  assert.equal(typeof config.headers, "function");
  const rules = await config.headers();
  const everyRoute = rules.find((rule) => rule.source === "/:path*");
  assert.ok(everyRoute, "a rule must cover every route");
  const sent = Object.fromEntries(
    everyRoute.headers.map(({ key, value }) => [key.toLowerCase(), value]),
  );
  assert.match(sent["content-security-policy"] ?? "", /frame-ancestors 'none'/);
  assert.equal(sent["x-frame-options"], "DENY");
  assert.equal(sent["x-content-type-options"], "nosniff");
  assert.equal(sent["referrer-policy"], "strict-origin-when-cross-origin");
  assert.match(sent["permissions-policy"] ?? "", /camera=\(\)/);
  assert.match(sent["strict-transport-security"] ?? "", /max-age=\d+/);
});
