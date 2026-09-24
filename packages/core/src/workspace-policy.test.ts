import { describe, it, expect } from "vitest";
import {
  workspacePolicySchema,
  missingWorkspaceFields,
} from "./workspace-policy.js";
describe("workspace policies", () => {
  it("preserves zero commercial facts while blocking absent and unsupported required fields", () => {
    expect(
      missingWorkspaceFields(
        { stockQuantity: 0, priceHkd: 0, producer: null },
        ["stockQuantity", "priceHkd", "producer", "unknown"],
      ),
    ).toEqual(["producer", "unknown"]);
  });
  it("refuses a credential or a paid capability in editable policy", () => {
    const policy = {
      name: "Second shop",
      tone: "Plain",
      claimPolicy: [],
      requiredFields: [],
      sourcePreferences: { allowedDomains: ["producer.example"] },
    };
    expect(workspacePolicySchema.safeParse(policy).success).toBe(true);
    expect(
      workspacePolicySchema.safeParse({ ...policy, listingAi: {} }).success,
    ).toBe(false);
    expect(
      workspacePolicySchema.safeParse({
        ...policy,
        sourcePreferences: {
          allowedDomains: ["https://producer.example/private"],
        },
      }).success,
    ).toBe(false);
  });
});
