import { z } from "zod";
export const WEBSITE_INGRESS_PATH = "/ingress/website-scans";
export const WEBSITE_DOCUMENT_PATH = "/api/internal/website-document";
export const websiteJobSchema = z
  .object({
    kind: z.literal("website_scan"),
    workspaceId: z.string().min(1),
    scanId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const websiteDocumentRequestSchema = websiteJobSchema
  .extend({ leaseToken: z.string().uuid() })
  .strict();
export type WebsiteJob = z.infer<typeof websiteJobSchema>;
export type WebsiteDocumentRequest = z.infer<
  typeof websiteDocumentRequestSchema
>;
