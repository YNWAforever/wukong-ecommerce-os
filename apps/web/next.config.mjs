import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(appRoot, "../..");

/**
 * libvips, as pnpm actually lays it out. Shared by every route that imports
 * sharp so the six entries below cannot drift apart from one another.
 */
const SHARP_NATIVE_LIBRARY = [
  "../../node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/*.so*",
  "../../node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/*.dylib",
];

/** @type {import('next').NextConfig} */
const config = {
  outputFileTracingRoot: monorepoRoot,
  // Node File Trace's static analysis doesn't follow the dlopen() call
  // sharp's platform binding uses to load libvips's shared library, so that
  // file is silently dropped from a route's deployed function bundle without
  // this -- sharp then fails at runtime with ERR_DLOPEN_FAILED even though the
  // file is present in node_modules.
  //
  // Every route listed here has sharp in its build trace; `approve` was the
  // only one covered, and the other five would have failed the moment they
  // actually decoded an image. The image routes are the ones whose whole job
  // is image work, so the gap was widest exactly where it mattered most.
  // `tests/sharp-native-bundling.test.mjs` derives the required set from the
  // build output rather than repeating this list, so a new sharp-importing
  // route fails the build gate instead of shipping without its library.
  //
  // The file globs are deliberately narrow and unchanged: they walk straight
  // into pnpm's real content-addressed directories. An earlier broad, unscoped
  // glob failed to build on Vercel entirely (ENOENT), most likely from
  // matching the virtual store's symlinked entries.
  outputFileTracingIncludes: {
    "/api/listings/*/approve": SHARP_NATIVE_LIBRARY,
    "/api/listings/*/process": SHARP_NATIVE_LIBRARY,
    "/api/listings/*/product-shot": SHARP_NATIVE_LIBRARY,
    "/api/listings/*/product-shot/approve": SHARP_NATIVE_LIBRARY,
    "/api/listings/*/product-shot/prepare": SHARP_NATIVE_LIBRARY,
    "/api/listings/*/product-shot/source": SHARP_NATIVE_LIBRARY,
  },
  turbopack: {
    root: monorepoRoot,
  },
};

export default config;
