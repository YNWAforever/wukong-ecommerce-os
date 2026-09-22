import {
  QUESTION_SET_VERSION,
  verificationResultSchema,
  type ListingVerifier,
  type VerificationInput,
  type VerificationResult,
} from "@wukong/ai";

export async function sha256(value: unknown): Promise<string> {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, stable(child)]),
      );
    return item;
  };
  const data = new TextEncoder().encode(JSON.stringify(stable(value)));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function unavailableVerification(
  reason: "configuration" | "network" | "invalid_response" | "timeout",
  requestAttempted: boolean,
  latencyMs = 0,
): VerificationResult {
  return {
    schemaVersion: 1,
    questionSetVersion: QUESTION_SET_VERSION,
    mode: "advisory",
    outcome: "unavailable",
    reason,
    requestedModel: "unavailable",
    actualModel: null,
    checkedAt: new Date().toISOString(),
    checks: [],
    numericDifferences: [],
    usage: {
      inputTokens: requestAttempted ? null : 0,
      outputTokens: requestAttempted ? null : 0,
      estimatedCostUsd: requestAttempted ? null : 0,
      pricingVersion: null,
      latencyMs,
      requestAttempted,
    },
  };
}

/** The injected port is untrusted too. No raw errors or malformed payloads escape. */
export async function verifyAdvisory(
  input: VerificationInput,
  verifier: ListingVerifier,
): Promise<VerificationResult> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = Symbol("timeout");
  try {
    const deadline = new Promise<typeof timeout>((resolve) => {
      timer = setTimeout(() => resolve(timeout), 5000);
    });
    const raw: unknown = await Promise.race([
      Promise.resolve().then(() => verifier.verify(input)),
      deadline,
    ]);
    if (raw === timeout || Date.now() - startedAt >= 5000)
      return unavailableVerification(
        "timeout",
        true,
        Math.max(0, Date.now() - startedAt),
      );
    const parsed = verificationResultSchema.safeParse(raw);
    if (Date.now() - startedAt >= 5000) {
      const result = unavailableVerification(
        "timeout",
        true,
        Math.max(0, Date.now() - startedAt),
      );
      if (parsed.success)
        result.usage = {
          ...parsed.data.usage,
          latencyMs: result.usage.latencyMs,
        };
      return result;
    }
    if (parsed.success) return parsed.data;
    const fallback = unavailableVerification(
      "invalid_response",
      true,
      Math.max(0, Date.now() - startedAt),
    );
    if (raw && typeof raw === "object" && "usage" in raw) {
      const usage = verificationResultSchema.shape.usage.safeParse(raw.usage);
      if (usage.success) fallback.usage = usage.data;
    }
    return fallback;
  } catch {
    return unavailableVerification(
      Date.now() - startedAt >= 5000 ? "timeout" : "network",
      true,
      Math.max(0, Date.now() - startedAt),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
