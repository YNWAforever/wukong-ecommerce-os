import postgres from "postgres";

import { inspectSchemaInventory, readOnly } from "../schema-inventory.js";

// Read-only production recovery check. Prints IDs, booleans and counts only;
// never the connection string, SQL text or an error message.
const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error(
    JSON.stringify({
      event: "schema_inventory",
      ready: false,
      code: "database_not_configured",
    }),
  );
  process.exit(1);
}

const client = postgres(url, {
  connect_timeout: 10,
  max: 1,
  onnotice: () => undefined,
  prepare: false,
});

try {
  const report = await readOnly(client, (transaction) =>
    inspectSchemaInventory((sql) => transaction.unsafe(sql)),
  );
  console.log(JSON.stringify({ event: "schema_inventory", ...report }));
  process.exitCode = report.missing.length > 0 ? 2 : 0;
} catch (error) {
  const code =
    typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : error instanceof Error
        ? error.name
        : "UnknownError";
  console.error(
    JSON.stringify({ event: "schema_inventory", ready: false, code }),
  );
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
