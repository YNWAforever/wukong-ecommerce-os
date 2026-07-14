import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_ADMIN_URL;

if (!url) {
  throw new Error("DATABASE_ADMIN_URL is required for migrations");
}

export default defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema.ts",
  dbCredentials: { url },
});
