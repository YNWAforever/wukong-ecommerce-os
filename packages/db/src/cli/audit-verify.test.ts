import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "../schema.js";
import { parseAuditVerifyArgs, TENANT_TABLES } from "./audit-verify.js";

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
