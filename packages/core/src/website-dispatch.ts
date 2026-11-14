export type WebsiteDispatchRecoveryState =
  "retryable" | "waiting" | "expired" | "unavailable";
export type WebsiteDispatchSnapshot = Readonly<{
  state: string;
  dispatchStatus: string;
  deadlineAt: Date;
  nextEligibleAt: Date;
  leaseExpiresAt: Date | null;
  dispatchAt: Date | null;
}>;
/** Matches the existing stale-dispatch sweeper window. Never extends the scan deadline. */
export const WEBSITE_DISPATCH_RECOVERY_DELAY_MS = 60_000;
export function websiteDispatchRecoveryState(
  scan: WebsiteDispatchSnapshot,
  now: Date,
): WebsiteDispatchRecoveryState {
  const dates = [
    now,
    scan.deadlineAt,
    scan.nextEligibleAt,
    scan.leaseExpiresAt,
    scan.dispatchAt,
  ].filter((value): value is Date => value !== null);
  if (
    dates.some(
      (value) => !(value instanceof Date) || !Number.isFinite(value.getTime()),
    ) ||
    !["queued", "running"].includes(scan.state) ||
    !["pending", "sent", "failed"].includes(scan.dispatchStatus)
  )
    return "unavailable";
  if (now >= scan.deadlineAt) return "expired";
  if (
    now < scan.nextEligibleAt ||
    (scan.leaseExpiresAt !== null && now < scan.leaseExpiresAt)
  )
    return "waiting";
  if (
    scan.dispatchStatus === "failed" ||
    scan.dispatchAt === null ||
    scan.dispatchAt.getTime() <=
      now.getTime() - WEBSITE_DISPATCH_RECOVERY_DELAY_MS
  )
    return "retryable";
  return "waiting";
}
