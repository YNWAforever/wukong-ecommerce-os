import { describe, expect, it } from "vitest";

import { parseAuditVerifyArgs } from "./audit-verify.js";

describe("audit:verify arguments", () => {
  it("requires a draft and keeps workspace selection explicit", () => {
    expect(parseAuditVerifyArgs(["--workspace", "ws_opak", "--draft", "draft-1"], {
      DATABASE_URL: "postgres://example",
    })).toEqual({ workspaceId: "ws_opak", draftId: "draft-1", url: "postgres://example" });
  });

  it("accepts equals-form options for CI scripts", () => {
    expect(parseAuditVerifyArgs(["--workspace=ws_opak", "--draft=draft-1"], {
      DATABASE_URL: "postgres://example",
    })).toMatchObject({ workspaceId: "ws_opak", draftId: "draft-1" });
  });
});
