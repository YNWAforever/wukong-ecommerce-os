import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// Guards against a regression that shipped to production: sharp's native
// binding dlopen()s libvips's shared library at runtime, but Next's Node File
// Trace only follows static require()/import graphs, so it silently drops
// that shared library from the deployed serverless function bundle. The
// function then throws ERR_DLOPEN_FAILED in production even though the build
// succeeds locally and in CI. apps/web/next.config.mjs works around this with
// outputFileTracingIncludes; this test proves it's actually effective by
// inspecting a real production build's trace manifest, not just that the
// config key is present.
//
// Requires `pnpm --filter @wukong/web build` to have already run (CI runs
// this as the "Production build" step) -- skips gracefully otherwise, since
// this file has nothing to inspect without that output.

const root = fileURLToPath(new URL("../", import.meta.url));
const traceFile = `${root}apps/web/.next/server/app/api/listings/route.js.nft.json`;

describe("apps/web production build bundles sharp's native libvips library", () => {
  it("includes a libvips shared library in the /api/listings trace manifest", (t) => {
    if (!existsSync(traceFile)) {
      t.skip(
        "apps/web/.next build output not present -- run `pnpm --filter @wukong/web build` first",
      );
      return;
    }
    const trace = JSON.parse(readFileSync(traceFile, "utf8"));
    const libvipsSharedLibrary = trace.files.find(
      (file) =>
        /\.pnpm\/.*sharp-libvips/.test(file) &&
        /\.(so|dylib)(\.[0-9.]+)?$/.test(file),
    );
    assert.ok(
      libvipsSharedLibrary,
      "expected the /api/listings trace manifest to include a sharp-libvips shared library file " +
        "(.so on Linux, .dylib locally) -- if this is missing, apps/web/next.config.mjs's " +
        "outputFileTracingIncludes no longer covers sharp and the deployed function will fail " +
        "at runtime with ERR_DLOPEN_FAILED, the way it did in production",
    );
  });
});
