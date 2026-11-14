import { z } from "zod";

import {
  evidenceCheckSchema,
  evidenceCoverageSchema,
  translatedLineSchema,
} from "./types";

/**
 * Canonical payload of a merchant/SEO audit report artifact (plan Task 11).
 *
 * This is the stored, versioned artifact content — not a rendered answer — so
 * every field is data: counts read from canonical records, the read timestamp,
 * the evidence table, and limitations as copy keys plus values (the UI renders
 * them through `renderStudioLine`, and the export JSON carries the same
 * locale-independent lines). Nothing here is estimated; a missing source is
 * `missing` in `coverage`, never a zero row.
 */
export const merchantAuditListingRowSchema = z.strictObject({
  status: z.string().min(1).max(40),
  count: z.number().int().min(0),
});

export const merchantAuditExportRowSchema = z.strictObject({
  attemptId: z.string().min(1).max(200),
  state: z.string().min(1).max(40),
  rowCount: z.number().int().min(0),
  createdAt: z.string().min(1).max(64),
});

export const merchantAuditPeriodSchema = z.strictObject({
  /** First included UTC day, `YYYY-MM-DD`. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Last included UTC day, `YYYY-MM-DD`. */
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Locale-independent description of the parsed phrase. */
  label: z.string().min(1).max(120),
});
export type MerchantAuditPeriod = z.infer<typeof merchantAuditPeriodSchema>;

export const merchantAuditPayloadSchema = z.strictObject({
  schemaVersion: z.literal("wukong-merchant-audit/v2"),
  generatedAt: z.string().min(1).max(64),
  asOf: z.string().min(1).max(64),
  /**
   * The reporting period parsed from the turn text. `null` means no period was
   * named: the export table then lists recent attempts and the totals are
   * explicitly current snapshots (see limitations).
   */
  period: merchantAuditPeriodSchema.nullable(),
  /**
   * Export attempts whose `createdAt` falls inside `period`. `null` when no
   * period was set or the export source could not be read.
   */
  attemptsInPeriod: z.number().int().min(0).nullable(),
  scope: z.strictObject({ workspaceScoped: z.literal(true) }),
  /**
   * `null` means that source could not be read at all. It is never an empty
   * array standing in for "zero" — the coverage map and limitations say why.
   */
  listings: z.array(merchantAuditListingRowSchema).max(30).nullable(),
  quality: z
    .strictObject({
      assessmentVersion: z.string().min(1).max(120),
      totalListings: z.number().int().min(0),
      totalAssessed: z.number().int().min(0),
      cleanCount: z.number().int().min(0),
      hasGapsCount: z.number().int().min(0),
      projectionState: z.string().min(1).max(40),
      asOf: z.string().max(64).nullable(),
    })
    .nullable(),
  exports: z.array(merchantAuditExportRowSchema).max(20).nullable(),
  checks: z.array(evidenceCheckSchema).max(50),
  coverage: z.record(z.string(), evidenceCoverageSchema),
  limitations: z.array(translatedLineSchema).max(10),
});
export type MerchantAuditPayload = z.infer<typeof merchantAuditPayloadSchema>;

export const gapReportPayloadSchema = z.strictObject({
  schemaVersion: z.literal("wukong-gap-report/v1"),
  asOf: z.string().min(1).max(64),
  scope: z.strictObject({
    mode: z.enum(["workspace_sample", "selected"]),
    listingIds: z.array(z.uuid()).max(20),
    truncated: z.boolean().nullable(),
  }),
  listings: z
    .array(
      z.strictObject({
        listingId: z.uuid(),
        title: z.string().max(300).nullable(),
        status: z.string().max(40).nullable(),
        activeVersion: z
          .strictObject({
            versionId: z.uuid(),
            sequence: z.number().int().min(1),
          })
          .nullable(),
        gaps: z
          .array(
            z.strictObject({
              code: z.string().min(1).max(200),
              blocking: z.boolean(),
            }),
          )
          .max(100)
          .nullable(),
      }),
    )
    .max(20)
    .nullable(),
  quality: z
    .strictObject({
      assessmentVersion: z.string().min(1).max(120),
      projectionState: z.enum(["ready", "pending", "failed"]),
      asOf: z.string().max(64).nullable(),
    })
    .nullable(),
  checks: z.array(evidenceCheckSchema).max(50),
  evidenceTruncated: z.boolean(),
  coverage: z.record(z.string(), evidenceCoverageSchema),
  limitations: z.array(translatedLineSchema).max(10),
});
export type GapReportPayload = z.infer<typeof gapReportPayloadSchema>;
