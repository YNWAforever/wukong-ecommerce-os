export type ProviderFailureCategory =
  | "rate_limited"
  | "timeout"
  | "invalid_media"
  | "refusal"
  | "invalid_output"
  | "missing_configuration"
  | "provider_unavailable"
  | "internal";

export type ProviderDiagnostic = {
  category: ProviderFailureCategory;
  retryable: boolean;
  httpStatus: number | null;
  providerCode: string | null;
  requestId: string | null;
};

export type PhysicalInvocationUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  certainty: "measured" | "estimated" | "unknown";
};

export type PhysicalInvocationRecord = {
  /** Transport-owned: only the first repairable schema parse failure. */
  schemaRepairEligible?: boolean;
  ordinal: number;
  phase: "request" | "repair" | "transport_retry";
  outcome: "started" | "response" | "api_error" | "refusal" | "invalid_output";
  diagnostic: ProviderDiagnostic;
  usage: PhysicalInvocationUsage;
};

export type PhysicalInvocationObserver = (
  record: PhysicalInvocationRecord,
) => void | Promise<void>;

const SAFE_CODES = new Set([
  "invalid_api_key",
  "insufficient_quota",
  "rate_limit_exceeded",
  "model_not_found",
  "invalid_json_schema",
  "invalid_request_error",
  "unsupported_parameter",
  "invalid_value",
  "server_error",
  "invalid_image",
  "invalid_image_url",
  "image_parse_error",
]);
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function field(error: unknown, key: string): unknown {
  return error && typeof error === "object" && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

export function providerFailureDiagnostic(error: unknown): ProviderDiagnostic {
  const rawStatus = field(error, "status") ?? field(error, "statusCode");
  const httpStatus =
    typeof rawStatus === "number" &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 400 &&
    rawStatus <= 599
      ? rawStatus
      : null;
  const rawCode = field(error, "code");
  const providerCode =
    typeof rawCode === "string" && SAFE_CODES.has(rawCode) ? rawCode : null;
  const rawRequestId = field(error, "request_id") ?? field(error, "requestId");
  const requestId =
    typeof rawRequestId === "string" && SAFE_REQUEST_ID.test(rawRequestId)
      ? rawRequestId
      : null;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";

  let category: ProviderFailureCategory = "internal";
  let retryable = false;
  if (/abort|timeout|timed out|etimedout/i.test(`${name} ${message}`)) {
    category = "timeout";
    retryable = true;
  } else if (httpStatus === 429 || providerCode === "rate_limit_exceeded") {
    category = "rate_limited";
    retryable = true;
  } else if (
    providerCode === "invalid_image" ||
    providerCode === "invalid_image_url" ||
    providerCode === "image_parse_error"
  ) {
    category = "invalid_media";
  } else if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    providerCode === "invalid_api_key" ||
    providerCode === "insufficient_quota" ||
    providerCode === "model_not_found"
  ) {
    category = "missing_configuration";
  } else if (httpStatus !== null && httpStatus >= 500) {
    category = "provider_unavailable";
    retryable = true;
  }
  return { category, retryable, httpStatus, providerCode, requestId };
}

export class ListingProviderError extends Error {
  readonly diagnostic: ProviderDiagnostic & { usage?: PhysicalInvocationUsage };

  constructor(
    message: string,
    diagnostic: ProviderDiagnostic & { usage?: PhysicalInvocationUsage } = {
      category: "internal",
      retryable: false,
      httpStatus: null,
      providerCode: null,
      requestId: null,
    },
  ) {
    super(message);
    this.name = new.target.name;
    this.diagnostic = diagnostic;
  }
}

export class UnsupportedAssetError extends ListingProviderError {}
export class ProviderApiError extends ListingProviderError {}
export class ProviderRefusalError extends ListingProviderError {}
export class ProviderOutputError extends ListingProviderError {}
