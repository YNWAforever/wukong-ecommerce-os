import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  buildMigrationSet,
  verifyMigrationSet,
  type MigrationSetManifest,
} from "../migration-set.js";

// Builds or verifies a controlled migration set. Touches no database.
const { values } = parseArgs({
  options: {
    include: { type: "string" },
    out: { type: "string" },
    verify: { type: "string" },
  },
});

try {
  if (!values.out) throw new Error("usage: --out <dir> required");
  if (values.verify) {
    const expected = JSON.parse(
      await readFile(values.verify, "utf8"),
    ) as MigrationSetManifest;
    await verifyMigrationSet(values.out, expected);
    console.log(
      JSON.stringify({
        event: "migration_set_verified",
        files: expected.files,
      }),
    );
  } else {
    if (!values.include)
      throw new Error("usage: --include <prefixes> required");
    const manifest = await buildMigrationSet({
      sourceDir: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
      include: values.include.split(",").map((prefix) => prefix.trim()),
      outDir: values.out,
    });
    console.log(JSON.stringify({ event: "migration_set_built", ...manifest }));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: "migration_set_failed",
      reason: error instanceof Error ? error.message : "UnknownError",
    }),
  );
  process.exitCode = 1;
}
