import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(appRoot, "../..");

/** @type {import('next').NextConfig} */
const config = {
  outputFileTracingRoot: monorepoRoot,
  // Node File Trace's static analysis doesn't follow the dlopen() call
  // sharp's platform binding uses to load libvips's shared library, so that
  // file is silently dropped from this route's deployed function bundle
  // without this -- sharp then fails at runtime with ERR_DLOPEN_FAILED even
  // though the file is present in node_modules. Scoped to only the one route
  // that imports sharp (via @wukong/assets/product-shot-flatten) so a bad
  // glob here can't affect any other route's bundle.
  outputFileTracingIncludes: {
    "/api/listings/*/approve": [
      "../../node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/*.so*",
      "../../node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/*.dylib",
    ],
  },
  turbopack: {
    root: monorepoRoot,
  },
};

export default config;
