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
  "listing.approved",
  "listing.csv_exported",
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
    // "approved" appears before "submitted_for_review" here, out of order —
    // the cursor consumes "submitted_for_review" at its real position and
    // then can't look backward to find the earlier "approved", so it's
    // correctly reported missing rather than matched out of sequence.
    expect(
      requiredSequenceMissing([
        "listing.imported",
        "listing.approved",
        "listing.submitted_for_review",
      ]),
    ).toEqual([
      "listing.approved",
      "listing.csv_exported or listing.bulk_form_exported or listing.published",
    ]);
  });

  it("accepts a listing delivered only by CSV, never queued or published", () => {
    // CSV and bulk-form export are both terminal — the operator uploads the
    // file to SHOPLINE by hand, and Wukong never queues or tracks a publish
    // for that delivery. Requiring publish_queued/published in addition would
    // make the gate unsatisfiable for a listing delivered this way.
    expect(
      requiredSequenceMissing([
        "listing.created",
        "listing.submitted_for_review",
        "listing.approved",
        "listing.csv_exported",
      ]),
    ).toEqual([]);
  });

  it("accepts a listing delivered only by bulk-form export", () => {
    expect(
      requiredSequenceMissing([
        "listing.imported",
        "listing.submitted_for_review",
        "listing.approved",
        "listing.bulk_form_exported",
      ]),
    ).toEqual([]);
  });

  it("accepts a listing that went through the full shopline_api chain", () => {
    expect(
      requiredSequenceMissing([
        "listing.created",
        "listing.submitted_for_review",
        "listing.approved",
        "listing.publish_queued",
        "listing.published",
      ]),
    ).toEqual([]);
  });

  it("does not require an edit during review", () => {
    // A listing approved on first submission never writes listing.edited —
    // that action is optional, not part of the required lifecycle.
    expect(
      requiredSequenceMissing([
        "listing.created",
        "listing.submitted_for_review",
        "listing.approved",
        "listing.csv_exported",
      ]),
    ).toEqual([]);
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
