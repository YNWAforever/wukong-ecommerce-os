import { z } from "zod";

/**
 * Studio output sign-off status vocabulary and wire normalizer.
 *
 * Server-safe on purpose: `/studio/outputs` renders status chips on the server,
 * while `StudioOutputCard` is a client component. Importing this helper from the
 * client module made Next treat it as a client reference and crashed the page at
 * render time with "Attempted to call toOutputStatus() from the server", so the
 * shared vocabulary lives here instead.
 */

export const outputStatusSchema = z.enum([
  "draft",
  "saved",
  "signed_off",
  "discarded",
]);

export type StudioOutputStatus = z.infer<typeof outputStatusSchema>;

/** Normalize a wire status; unknown values are not rendered as a status chip. */
export function toOutputStatus(value: unknown): StudioOutputStatus | null {
  const parsed = outputStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
