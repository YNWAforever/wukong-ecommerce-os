import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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
// A first attempt at fixing the approve route's own native-library bundling
// used a broad, unscoped outputFileTracingIncludes glob -- that deploy failed
// to build on Vercel entirely (ENOENT), most likely from matching pnpm's
// symlinked virtual-store entries. The fix below is scoped to only the one
// route that needs it, and uses a narrow glob that walks directly into
// pnpm's real (non-symlinked) content-addressed package directories instead
// of through any symlink indirection layer.
//
// Requires `pnpm --filter @wukong/web build` to have already run (CI runs
// this as the "Production build" step) -- skips gracefully otherwise, since
// this file has nothing to inspect without that output.

const root = fileURLToPath(new URL("../", import.meta.url));
const listingsTraceFile = `${root}apps/web/.next/server/app/api/listings/route.js.nft.json`;
const approveTraceFile = `${root}apps/web/.next/server/app/api/listings/[id]/approve/route.js.nft.json`;

function readTrace(traceFile, t) {
  if (!existsSync(traceFile)) {
    t.skip(
      "apps/web/.next build output not present -- run `pnpm --filter @wukong/web build` first",
    );
    return null;
  }
  return JSON.parse(readFileSync(traceFile, "utf8"));
}

describe("GET /api/listings does not transitively depend on sharp", () => {
  it("has no sharp/libvips reference in its production build trace manifest", (t) => {
    const trace = readTrace(listingsTraceFile, t);
    if (!trace) return;
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

describe("POST /api/listings/[id]/approve bundles sharp's native libvips library", () => {
  it("includes a libvips shared library in its production build trace manifest", (t) => {
    const trace = readTrace(approveTraceFile, t);
    if (!trace) return;
    // Windows bundles libvips inside @img/sharp-win32-x64 rather than its own
    // package, so next.config.mjs's globs cannot match and this has nothing to
    // measure. Failing here locally would be a false signal, and a false signal
    // is how a real one gets ignored. Linux -- the deploy target -- still runs.
    if (!libvipsIsSeparatePackage()) {
      t.skip(
        "this platform bundles libvips inside the arch package, so next.config.mjs's globs cannot apply here",
      );
      return;
    }
    const libvipsSharedLibrary = trace.files.find(
      (file) =>
        /\.pnpm\/.*sharp-libvips/.test(file) &&
        /\.(so|dylib)(\.[0-9.]+)?$/.test(file),
    );
    assert.ok(
      libvipsSharedLibrary,
      "expected the approve route's trace manifest to include a sharp-libvips shared library " +
        "file (.so on Linux, .dylib locally) -- if this is missing, next.config.mjs's " +
        "outputFileTracingIncludes no longer covers this route and it will fail at runtime with " +
        "ERR_DLOPEN_FAILED whenever a reviewer actually approves a listing with a background choice",
    );
  });
});

/**
 * Every route that imports sharp needs its native library traced.
 *
 * The check above pins the ONE route that was covered. That is the wrong shape
 * for an invariant: `outputFileTracingIncludes` was scoped to `approve` alone
 * while five other routes -- including every product-shot route, whose whole
 * job is image work -- also carried sharp in their trace and would have thrown
 * ERR_DLOPEN_FAILED the moment they actually decoded an image.
 *
 * So this derives the requirement from the build output instead of repeating a
 * list: add a route that imports sharp and forget its tracing entry, and this
 * fails rather than shipping a function that cannot load libvips.
 */
const appOutputRoot = `${root}apps/web/.next/server/app`;

/** Trace manifests under the built app, with their route paths. */
function routeTraces() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".nft.json")) continue;
      found.push({
        route: full
          .slice(appOutputRoot.length + 1)
          .split(path.sep)
          .join("/")
          .replace(/\/route\.js\.nft\.json$/, ""),
        files: JSON.parse(readFileSync(full, "utf8")).files,
      });
    }
  };
  walk(appOutputRoot);
  return found;
}

/**
 * Whether this platform ships libvips as its own package.
 *
 * On Linux and macOS it is `@img/sharp-libvips-<platform>`, which is what the
 * globs in next.config.mjs target. On Windows it lives inside
 * `@img/sharp-win32-x64/lib/*.dll` instead, so those globs cannot match and the
 * check has nothing to say -- the deploy target is Linux, and CI is where this
 * is authoritative.
 */
function libvipsIsSeparatePackage() {
  try {
    return readdirSync(`${root}node_modules/.pnpm`).some((entry) =>
      entry.startsWith("@img+sharp-libvips-"),
    );
  } catch {
    return false;
  }
}

describe("every route that imports sharp bundles libvips", () => {
  it("has a libvips shared library in each such trace manifest", (t) => {
    if (!existsSync(appOutputRoot)) {
      t.skip(
        "apps/web/.next build output not present -- run `pnpm --filter @wukong/web build` first",
      );
      return;
    }
    if (!libvipsIsSeparatePackage()) {
      t.skip(
        "this platform bundles libvips inside the arch package, so next.config.mjs's globs cannot apply here",
      );
      return;
    }

    const importsSharp = routeTraces().filter((trace) =>
      trace.files.some((file) => /(^|\/)(sharp|@img\+sharp)/i.test(file)),
    );
    assert.ok(
      importsSharp.length > 0,
      "expected at least the approve route to import sharp -- if nothing does, this guard is measuring nothing",
    );

    const missingLibrary = importsSharp
      .filter(
        (trace) =>
          !trace.files.some(
            (file) =>
              /\.pnpm\/.*sharp-libvips/.test(file) &&
              /\.(so|dylib)(\.[0-9.]+)?$/.test(file),
          ),
      )
      .map((trace) => trace.route);

    assert.deepEqual(
      missingLibrary,
      [],
      `these routes import sharp but have no libvips shared library traced, so they will throw ` +
        `ERR_DLOPEN_FAILED at runtime: ${missingLibrary.join(", ")}. Add them to ` +
        `outputFileTracingIncludes in apps/web/next.config.mjs, or stop them importing sharp.`,
    );
  });
});
