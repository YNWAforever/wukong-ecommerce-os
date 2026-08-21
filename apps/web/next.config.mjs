import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(appRoot, "../..");

/** @type {import('next').NextConfig} */
const config = {
  outputFileTracingRoot: monorepoRoot,
  // Node File Trace's static analysis doesn't follow the dlopen() call sharp's
  // platform binding uses to load libvips's shared library, so that file is
  // silently dropped from the deployed function bundle without this — sharp
  // then fails at runtime with ERR_DLOPEN_FAILED even though the file is
  // present in node_modules.
  outputFileTracingIncludes: {
    "/**": [
      "../../node_modules/.pnpm/@img+sharp-*/node_modules/@img/**/*",
      "../../node_modules/.pnpm/sharp@*/node_modules/**/*",
    ],
  },
  turbopack: {
    root: monorepoRoot,
  },
};

export default config;
