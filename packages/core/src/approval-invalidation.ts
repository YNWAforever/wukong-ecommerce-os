/**
 * An approval stops holding when its confirmations change or when a re-import
 * replaces the source import its receipt was bound to. Both are recorded under
 * one action so /jobs can count them together and split them by cause.
 */
export const APPROVAL_INVALIDATED_ACTION = "listing.approval_invalidated";

export const APPROVAL_INVALIDATION_CAUSES = [
  "confirmation_changed",
  "source_reimported_changed",
  "source_reimported_unchanged",
] as const;

export type ApprovalInvalidationCause =
  (typeof APPROVAL_INVALIDATION_CAUSES)[number];

export function isApprovalInvalidationCause(
  value: unknown,
): value is ApprovalInvalidationCause {
  return (
    typeof value === "string" &&
    (APPROVAL_INVALIDATION_CAUSES as readonly string[]).includes(value)
  );
}
