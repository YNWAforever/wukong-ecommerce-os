/** Compile the actual route factory as ESM without changing production module settings. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const output = new URL(
  "../../apps/web/node_modules/.wine-provider.mjs",
  import.meta.url,
);
await build({
  entryPoints: [
    fileURLToPath(new URL("./wine-provider-server.ts", import.meta.url)),
  ],
  outfile: fileURLToPath(output),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  alias: { "next/headers": "next/headers.js", "next/server": "next/server.js" },
  logLevel: "silent",
});
await import(output.href);
