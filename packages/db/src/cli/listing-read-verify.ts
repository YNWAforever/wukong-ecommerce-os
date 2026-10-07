import { parseArgs } from "node:util";

import postgres from "postgres";

import { createDatabase } from "../client.js";
import { verifyListingReads } from "../listing-read-verify.js";
import { readOnly } from "../schema-inventory.js";

// Release check: runs the listing detail reads through the runtime role.
// Prints listing IDs, call names and SQLSTATE codes only.
const { values } = parseArgs({
  options: {
    listing: { type: "string", multiple: true },
    sample: { type: "string", default: "10" },
  },
});

const adminUrl = process.env.DATABASE_ADMIN_URL;
const runtimeUrl = process.env.DATABASE_URL;
const fail = (code: string) => {
  console.error(
    JSON.stringify({ event: "listing_read_verify", ready: false, code }),
  );
  process.exitCode = 1;
};

const sample = Number(values.sample);
if (!adminUrl || !runtimeUrl) fail("database_not_configured");
else if (!Number.isInteger(sample) || sample < 0 || sample > 200)
  fail("invalid_sample");
else {
  const admin = postgres(adminUrl, {
    connect_timeout: 10,
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(runtimeUrl);
  try {
    const ids = values.listing ?? [];
    const targets = await readOnly(admin, async (transaction) => {
      const named = ids.length
        ? await transaction<{ workspace_id: string; id: string }[]>`
            select workspace_id, id::text as id from listing_drafts where id = any(${ids}::uuid[])`
        : [];
      const sampled = sample
        ? await transaction<{ workspace_id: string; id: string }[]>`
            select workspace_id, id::text as id from listing_drafts order by random() limit ${sample}`
        : [];
      const seen = new Map<string, string>();
      for (const row of [...named, ...sampled])
        seen.set(row.id, row.workspace_id);
      return [...seen].map(([listingId, workspaceId]) => ({
        workspaceId,
        listingId,
      }));
    });
    const report = await verifyListingReads(database, targets);
    console.log(JSON.stringify({ event: "listing_read_verify", ...report }));
    process.exitCode = report.failures.length > 0 ? 1 : 0;
  } catch (error) {
    fail(
      typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : error instanceof Error
          ? error.name
          : "UnknownError",
    );
  } finally {
    await database.close();
    await admin.end({ timeout: 5 });
  }
}
