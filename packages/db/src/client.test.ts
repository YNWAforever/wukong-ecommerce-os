import { expect, it } from "vitest";

import { createDatabase } from "./client.js";

it("pings the database with a trivial query", async () => {
  const queries: string[] = [];
  const database = createDatabase("postgres://user:pass@localhost:5432/db", {
    createClient: ((url: string, options: unknown) => {
      const client = async (strings: TemplateStringsArray) => {
        queries.push(strings.join("?"));
        return [{ ok: 1 }];
      };
      client.end = async () => undefined;
      // drizzle-orm's postgres-js driver reads/mutates these at construction
      // time to install transparent parsers/serializers for a handful of
      // Postgres type OIDs; a bare fake client needs the same shape.
      client.options = { parsers: {}, serializers: {} };
      return client;
    }) as never,
  });

  await database.ping();

  expect(queries).toEqual(["select 1"]);
});
