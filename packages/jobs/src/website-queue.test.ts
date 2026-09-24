import { describe, expect, it } from "vitest";
import * as jobs from "./index.js";

describe("website queue contracts", () => {
  const job = {
    kind: "website_scan",
    workspaceId: "workspace",
    scanId: "10000000-0000-4000-8000-000000000001",
    revision: 0,
  };
  it("exports a strict IDs-only job and callback contract", () => {
    expect(jobs).toHaveProperty("websiteJobSchema");
    expect(jobs.websiteJobSchema.parse(job)).toEqual(job);
    expect(
      jobs.websiteJobSchema.safeParse({ ...job, url: "https://store.example/" })
        .success,
    ).toBe(false);
    expect(jobs.websiteDocumentRequestSchema.safeParse(job).success).toBe(
      false,
    );
    expect(
      jobs.websiteDocumentRequestSchema.safeParse({
        ...job,
        leaseToken: job.scanId,
      }).success,
    ).toBe(true);
    expect(jobs.WEBSITE_INGRESS_PATH).toBe("/ingress/website-scans");
    expect(jobs.WEBSITE_DOCUMENT_PATH).toBe("/api/internal/website-document");
  });
});
