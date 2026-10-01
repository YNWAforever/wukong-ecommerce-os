export type BatchRecovery =
  | "retryable"
  | "needs-input"
  | "needs-review"
  | "outcome-unknown"
  | "support-required";
export function batchItemRecovery(input: {
  outcome: string | null;
  errorCode: string | null;
  costUnknown: boolean;
  isCurrent: boolean;
}): { recovery: BatchRecovery; canRetry: boolean } {
  if (input.costUnknown)
    return { recovery: "outcome-unknown", canRetry: false };
  if (input.outcome === "needs_input")
    return { recovery: "needs-input", canRetry: false };
  if (
    ["this_run_success", "already_prepared", "superseded"].includes(
      input.outcome ?? "",
    )
  )
    return { recovery: "needs-review", canRetry: false };
  if (
    input.isCurrent &&
    input.outcome === "failed" &&
    [
      "provider_failure",
      "provider_timeout",
      "rate_limited",
      "timeout",
      "provider_unavailable",
      "dispatch_exhausted",
      "operation_abandoned",
    ].includes(input.errorCode ?? "")
  )
    return { recovery: "retryable", canRetry: true };
  return { recovery: "support-required", canRetry: false };
}
