import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComplianceFlags } from "./compliance-flags";

const openFlag = {
  id: "description:health_claim:0",
  code: "health_claim",
  field: "description",
  label: "健康功效聲稱",
  description: "移除未有來源支持的健康功效描述。",
  status: "open" as const,
  resolutionReason: null,
};

describe("ComplianceFlags", () => {
  it("renders a required review reason and resolution action for an open flag", () => {
    const markup = renderToStaticMarkup(
      <ComplianceFlags
        flags={[openFlag]}
        canResolve
        onResolve={() => undefined}
      />,
    );

    expect(markup).toContain("處理理由");
    expect(markup).toContain("至少 10 個字元");
    expect(markup).toContain("標記為已處理");
    expect(markup).not.toContain('disabled=""');
  });

  it("shows the recorded reason without another action for a resolved flag", () => {
    const markup = renderToStaticMarkup(
      <ComplianceFlags
        flags={[
          {
            ...openFlag,
            status: "resolved",
            resolutionReason: "Unsupported wording removed by reviewer.",
          },
        ]}
        canResolve
        onResolve={() => undefined}
      />,
    );

    expect(markup).toContain("Unsupported wording removed by reviewer.");
    expect(markup).not.toContain("標記為已處理");
  });
});
