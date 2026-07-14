import { createDatabase } from "./client.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_ADMIN_URL;

if (!runtimeUrl || !migrationUrl) {
  throw new Error("DATABASE_URL and DATABASE_ADMIN_URL are required");
}

const database = createDatabase(runtimeUrl, { migrationUrl });
try {
  await database.migrate();
} finally {
  await database.close();
}
