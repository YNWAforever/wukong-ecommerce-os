import { createDatabase } from "../client.js";

// Deployment gate only. It never migrates, changes grants or reads listings.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    JSON.stringify({
      event: "listing_read_preflight",
      ready: false,
      reason: "database_not_configured",
    }),
  );
  process.exitCode = 1;
} else {
  const database = createDatabase(url);
  try {
    const report = await database.inspectListingReadCompatibility!();
    console.log(JSON.stringify({ event: "listing_read_preflight", ...report }));
    process.exitCode = report.ready ? 0 : 1;
  } catch {
    console.error(
      JSON.stringify({
        event: "listing_read_preflight",
        ready: false,
        reason: "catalog_unavailable",
      }),
    );
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
