import { describe, expect, it } from "vitest";
import {
  productShotJobSchema,
  PRODUCT_SHOT_INGRESS_PATH,
} from "./product-shot-queue.js";
const job = {
  kind: "product_shot",
  workspaceId: "ws",
  draftId: "10000000-0000-4000-8000-000000000001",
  attemptId: "10000000-0000-4000-8000-000000000002",
};
describe("product shot queue", () => {
  it("accepts only durable scoped identifiers", () => {
    expect(PRODUCT_SHOT_INGRESS_PATH).toBe("/ingress/product-shots");
    expect(productShotJobSchema.parse(job)).toEqual(job);
    for (const extra of [
      { storageKey: "secret" },
      { bytes: [] },
      { url: "https://invalid.test" },
    ])
      expect(productShotJobSchema.safeParse({ ...job, ...extra }).success).toBe(
        false,
      );
    expect(
      productShotJobSchema.safeParse({ ...job, attemptId: "bad" }).success,
    ).toBe(false);
    expect(
      productShotJobSchema.safeParse({ ...job, kind: "website_scan" }).success,
    ).toBe(false);
  });
});
