import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "../schema.js";
import {
  parseAuditVerifyArgs,
  requiredSequenceMissing,
  TENANT_TABLES,
} from "./audit-verify.js";

const FULL_LIFECYCLE = [
  "listing.submitted_for_review",
  "listing.edited",
  "listing.approved",
  "listing.csv_exported",
  "listing.publish_queued",
  "listing.published",
];

describe("audit:verify arguments", () => {
  it("requires a draft and keeps workspace selection explicit", () => {
    expect(
      parseAuditVerifyArgs(["--workspace", "ws_opak", "--draft", "draft-1"], {
        DATABASE_URL: "postgres://example",
      }),
    ).toEqual({
      workspaceId: "ws_opak",
      draftId: "draft-1",
      url: "postgres://example",
    });
  });

  it("accepts equals-form options for CI scripts", () => {
    expect(
      parseAuditVerifyArgs(["--workspace=ws_opak", "--draft=draft-1"], {
        DATABASE_URL: "postgres://example",
      }),
    ).toMatchObject({ workspaceId: "ws_opak", draftId: "draft-1" });
  });
});

describe("required audit sequence", () => {
  it("accepts a draft that an operator typed in", () => {
    expect(
      requiredSequenceMissing(["listing.created", ...FULL_LIFECYCLE]),
    ).toEqual([]);
  });

  it("accepts a draft that came from a catalog import", () => {
    // Without this the gate is unsatisfiable for every imported product: the
    // importer writes `listing.imported`, never `listing.created`.
    expect(
      requiredSequenceMissing(["listing.imported", ...FULL_LIFECYCLE]),
    ).toEqual([]);
  });

  it("still requires the draft to have been opened somehow", () => {
    expect(requiredSequenceMissing(FULL_LIFECYCLE)).toEqual([
      "listing.created or listing.imported",
    ]);
  });

  it("keeps the remaining steps ordered", () => {
    expect(
      requiredSequenceMissing([
        "listing.imported",
        "listing.approved",
        "listing.submitted_for_review",
      ]),
    ).toEqual([
      "listing.edited",
      "listing.approved",
      "listing.csv_exported",
      "listing.publish_queued",
      "listing.published",
    ]);
  });
});

describe("tenant table probe list", () => {
  it("covers every workspace-scoped table in the schema", () => {
    const scoped = Object.values(schema)
      .filter((value): value is Parameters<typeof getTableConfig>[0] => {
        try {
          return "workspaceId" in getTableColumns(value as never);
        } catch {
          return false;
        }
      })
      .map((table) => getTableConfig(table).name)
      .sort();

    expect([...TENANT_TABLES].sort()).toEqual(scoped);
  });

  it("includes the platform products link table", () => {
    expect(TENANT_TABLES).toContain("platform_products");
  });
});
