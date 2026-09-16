import postgres from "postgres";

import {
  inspectSchemaCompatibility,
  type SchemaCapabilityRow,
} from "../schema-compatibility.js";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL is required");

const client = postgres(url, {
  max: 1,
  onnotice: () => undefined,
  prepare: false,
});

try {
  const report = await inspectSchemaCompatibility((sql) =>
    client.unsafe<SchemaCapabilityRow[]>(sql),
  );
  console.log(JSON.stringify(report));
  if (!report.ready) process.exitCode = 2;
} finally {
  await client.end();
}
