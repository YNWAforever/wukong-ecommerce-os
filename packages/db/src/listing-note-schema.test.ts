import { getTableColumns } from "drizzle-orm";
import { expect, it } from "vitest";

import { listingDrafts } from "./schema.js";

it("persists optional intake notes on listing drafts", () => {
  expect(getTableColumns(listingDrafts)).toHaveProperty("note");
});
