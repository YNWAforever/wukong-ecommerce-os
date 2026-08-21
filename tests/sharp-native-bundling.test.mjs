import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// Guards against a regression that shipped to production: GET /api/listings
// (the admin panel's home page) started returning 500s because
// packages/assets/src/index.ts re-exported product-shot-flatten.ts (which
// imports the native `sharp` module) via `export *`. That made `sharp` a
// transitive import of every route touching @wukong/assets, including this
// one, which never uses it. Next's Node File Trace doesn't follow the
// dlopen() call sharp's native binding uses to load libvips's shared
// library, so that file silently gets dropped from the deployed serverless
// function bundle -- the function then throws ERR_DLOPEN_FAILED at runtime
// even though the build succeeds locally and in CI.
//
// The fix is structural, not a bundler workaround: product-shot-flatten.ts
// is exported from its own package subpath (@wukong/assets/product-shot-flatten),
// not the shared barrel, so only the one route that actually needs it
// (POST /api/listings/[id]/approve) pulls sharp into its module graph.
// This test proves the decoupling actually holds for the route that broke.
//
// Requires `pnpm --filter @wukong/web build` to have already run (CI runs
// this as the "Production build" step) -- skips gracefully otherwise, since
// this file has nothing to inspect without that output.

const root = fileURLToPath(new URL("../", import.meta.url));
const traceFile = `${root}apps/web/.next/server/app/api/listings/route.js.nft.json`;

describe("GET /api/listings does not transitively depend on sharp", () => {
  it("has no sharp/libvips reference in its production build trace manifest", (t) => {
    if (!existsSync(traceFile)) {
      t.skip(
        "apps/web/.next build output not present -- run `pnpm --filter @wukong/web build` first",
      );
      return;
    }
    const trace = JSON.parse(readFileSync(traceFile, "utf8"));
    const sharpReferences = trace.files.filter((file) =>
      /(^|\/)(sharp|@img\+sharp)/i.test(file),
    );
    assert.deepEqual(
      sharpReferences,
      [],
      "GET /api/listings' trace manifest references sharp/@img+sharp -- this route doesn't use " +
        "image compositing and must not transitively import it (that coupling is what broke " +
        "production). If this now legitimately needs sharp, this test's premise no longer holds " +
        "and it should be revisited alongside the native-library-bundling problem it was written " +
        "to avoid.",
    );
  });
});
