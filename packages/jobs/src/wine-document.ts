import { z } from "zod";
export const WINE_DOCUMENT_PATH = "/api/internal/wine-evidence-document";
export const WINE_DOCUMENT_TEXT_LIMIT = 16_000;
export const WINE_DOCUMENT_TRUNCATION_MARKER = "\n[TRUNCATED]";
export const wineDocumentRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).max(200),
  runId: z.uuid(),
  sourceId: z.uuid(),
  inputRevision: z.number().int().nonnegative(),
  kind: z.enum(["robots", "product"]),
});
export type WineDocumentRequest = z.infer<typeof wineDocumentRequestSchema>;
export const wineDocumentResultSchema = wineDocumentRequestSchema
  .extend({
    schemaVersion: z.literal(1),
    state: z.enum(["ready", "denied", "unavailable"]),
    url: z.url().refine((url) => url.startsWith("https://")),
    capturedAt: z.iso.datetime(),
    title: z.string().max(500),
    text: z.string().max(WINE_DOCUMENT_TEXT_LIMIT),
    documentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    truncated: z.boolean(),
    spans: z
      .array(
        z.strictObject({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          location: z.string().max(200),
        }),
      )
      .max(1),
    warnings: z.array(z.string().max(100)).max(30),
    extractEligible: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.state !== "ready" || value.kind === "robots") &&
      (value.text !== "" || value.spans.length !== 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Only ready product results may retain document content",
      });
    for (const span of value.spans)
      if (span.end <= span.start || span.end > value.text.length)
        ctx.addIssue({
          code: "custom",
          message: "Invalid retained source span",
        });
    if (
      value.extractEligible &&
      (value.kind !== "product" || value.state !== "ready")
    )
      ctx.addIssue({
        code: "custom",
        message: "Extract requires an accessible product document",
      });
    if (
      value.truncated &&
      !value.text.endsWith(WINE_DOCUMENT_TRUNCATION_MARKER)
    )
      ctx.addIssue({ code: "custom", message: "Truncation marker required" });
  });
export type WineDocumentResult = z.infer<typeof wineDocumentResultSchema>;
