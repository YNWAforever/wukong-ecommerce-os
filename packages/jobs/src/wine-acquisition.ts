import { z } from "zod";
/** Immutable accepted coordinates, stored once at execution.wineAcquisition. */
export const wineAcquisitionPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  deadlineAt: z.iso.datetime(),
  policyVersion: z.string().min(1).max(200),
  rulesVersion: z.string().min(1).max(200),
  allowedDomains: z
    .array(
      z
        .string()
        .max(253)
        .regex(
          /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        ),
    )
    .min(1)
    .max(100),
});
export type WineAcquisitionPolicy = z.infer<typeof wineAcquisitionPolicySchema>;
export const wineSearchOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  results: z
    .array(
      z
        .strictObject({
          url: z
            .url()
            .max(2048)
            .refine((raw) => {
              const url = new URL(raw);
              return (
                url.protocol === "https:" && !url.username && !url.password
              );
            }),
          title: z.string().max(500),
          content: z.string().max(16000),
          truncated: z.boolean(),
        })
        .refine(
          (r) => !r.truncated || r.content.endsWith("\n[TRUNCATED]"),
          "Truncation marker required",
        ),
    )
    .max(5),
  requestId: z
    .string()
    .max(200)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .nullable(),
});
export type WineSearchOutput = z.infer<typeof wineSearchOutputSchema>;
export const wineSearchDiagnosticSchema = z.strictObject({
  schemaVersion: z.literal(1),
  code: z.enum([
    "rejected",
    "rate_limited",
    "invalid_output",
    "outcome_unknown",
    "cost_discrepancy",
  ]),
  requestId: z
    .string()
    .max(200)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .nullable(),
  measuredCredits: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  reservedCredits: z.number().int().min(1).max(2),
  httpStatus: z.number().int().min(100).max(599).nullable(),
});
export type WineSearchDiagnostic = z.infer<typeof wineSearchDiagnosticSchema>;
