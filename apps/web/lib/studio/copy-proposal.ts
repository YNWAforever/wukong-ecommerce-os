import { z } from "zod";

/**
 * The persisted `copy_proposal` payload contract (plan Task 9 + B2).
 *
 * It lives in a plain library module rather than in the review-card component
 * so the server-side handoff resolver and the export route can parse the same
 * stored payload without importing client code. The card re-exports the schema
 * for its existing consumers.
 *
 * A field is identified by its stored id (`sku`, `title.en`): there is no
 * label map here, because prettifying an id into a human label is a translation
 * decision the producer did not record.
 */

export const proposalFieldSchema = z.object({
  field: z.string().min(1).max(200),
  /** The persisted current value for the field; null means genuinely absent. */
  current: z.string().max(4000).nullable(),
  proposed: z.string().min(1).max(4000),
  evidenceRefs: z.array(z.string().min(1).max(200)).max(20),
});

export const copyProposalPayloadSchema = z.object({
  listingId: z.string().min(1).max(200),
  activeVersionId: z.string().min(1).max(200),
  activeVersionSequence: z.number().int().min(0),
  fields: z.array(proposalFieldSchema).max(60),
  limitations: z.array(z.string().max(500)).max(20).default([]),
  asOf: z.string().min(1).max(64),
});

export type CopyProposalField = z.infer<typeof proposalFieldSchema>;
export type CopyProposalPayload = z.infer<typeof copyProposalPayloadSchema>;

/** Parse an untrusted persisted payload, or null when it is not this kind. */
export function parseCopyProposalPayload(
  payload: unknown,
): CopyProposalPayload | null {
  const parsed = copyProposalPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Printable text for "copy all proposed values": one `field: proposed` line
 * per field, in the proposal's stored order. Raw field ids, no labels.
 */
export function formatProposedValues(
  fields: ReadonlyArray<Pick<CopyProposalField, "field" | "proposed">>,
): string {
  return fields.map((field) => `${field.field}: ${field.proposed}`).join("\n");
}
