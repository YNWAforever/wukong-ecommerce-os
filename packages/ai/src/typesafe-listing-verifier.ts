import {
  CHECK_FIELDS,
  CHECK_IDS,
  QUESTION_SET_VERSION,
  prepareVerification,
  verificationResultSchema,
  type CheckId,
  type ListingVerifier,
  type VerificationCheck,
  type VerificationInput,
  type VerificationResult,
} from "./listing-verification.js";
import { estimateTypeSafeCost } from "./typesafe-pricing.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 65_536;
const UNCONFIGURED_MODEL = "unconfigured";

export type TypeSafeListingVerifierOptions = {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  now?: () => number;
};

class DeadlineError extends Error {}
class ResponseLimitError extends Error {}

type Usage = { inputTokens: number | null; outputTokens: number | null };

function emptyUsage(): Usage {
  return { inputTokens: null, outputTokens: null };
}

function parseUsage(value: unknown): Usage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["input_tokens", "output_tokens"])
  )
    return emptyUsage();
  const input = value.input_tokens;
  const output = value.output_tokens;
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    (input as number) < 0 ||
    (output as number) < 0
  )
    return emptyUsage();
  return { inputTokens: input as number, outputTokens: output as number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

async function readBoundedBody(
  response: Response,
  deadline: Promise<never>,
): Promise<string> {
  if (!response.body) throw new SyntaxError("missing body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const item = await Promise.race([reader.read(), deadline]);
      if (item.done) {
        complete = true;
        break;
      }
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new ResponseLimitError();
      chunks.push(item.value);
    }
  } finally {
    if (!complete) {
      void reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function unavailable(
  requestedModel: string,
  checkedAt: string,
  latencyMs: number,
  reason: VerificationResult["reason"],
  requestAttempted: boolean,
  usage: Usage,
  actualModel: string | null = null,
  pricingModel: string | null = actualModel,
): VerificationResult {
  const pricing = requestAttempted
    ? estimateTypeSafeCost(
        pricingModel ?? "",
        usage.inputTokens,
        usage.outputTokens,
      )
    : { estimatedCostUsd: 0, pricingVersion: null };
  return verificationResultSchema.parse({
    schemaVersion: 1,
    questionSetVersion: QUESTION_SET_VERSION,
    mode: "advisory",
    outcome:
      reason === "invalid_input" || reason === "input_too_large"
        ? "skipped"
        : "unavailable",
    reason,
    requestedModel,
    actualModel,
    checkedAt,
    checks: [],
    numericDifferences: [],
    usage: {
      ...usage,
      ...pricing,
      latencyMs,
      requestAttempted,
    },
  });
}

export function createTypeSafeListingVerifier(
  options: TypeSafeListingVerifierOptions,
): ListingVerifier {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const requestedModel = options.model.trim() || UNCONFIGURED_MODEL;

  return {
    async verify(input: VerificationInput): Promise<VerificationResult> {
      const startedAt = now();
      const checkedAt = new Date(startedAt).toISOString();
      const prepared = prepareVerification(input);
      if (prepared.reason !== null) {
        return unavailable(
          requestedModel,
          checkedAt,
          Math.max(0, now() - startedAt),
          prepared.reason,
          false,
          { inputTokens: 0, outputTokens: 0 },
        );
      }
      if (!options.apiKey.trim() || !options.model.trim()) {
        return unavailable(
          requestedModel,
          checkedAt,
          Math.max(0, now() - startedAt),
          "configuration",
          false,
          { inputTokens: 0, outputTokens: 0 },
        );
      }

      const preparationElapsedMs = Math.max(0, now() - startedAt);
      if (preparationElapsedMs >= TIMEOUT_MS) {
        return unavailable(
          requestedModel,
          checkedAt,
          preparationElapsedMs,
          "timeout",
          false,
          { inputTokens: 0, outputTokens: 0 },
        );
      }

      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new DeadlineError());
          controller.abort();
        }, TIMEOUT_MS - preparationElapsedMs);
      });
      let usage = emptyUsage();
      try {
        const response = await Promise.race([
          fetchImpl(ENDPOINT, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: options.model,
              state: prepared.state,
              questions: prepared.questions,
            }),
          }),
          deadline,
        ]);
        if (!response.ok) {
          return unavailable(
            requestedModel,
            checkedAt,
            Math.max(0, now() - startedAt),
            "http",
            true,
            usage,
          );
        }
        const raw = await readBoundedBody(response, deadline);
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw);
        } catch {
          throw new SyntaxError("invalid JSON");
        }
        if (isRecord(decoded)) usage = parseUsage(decoded.usage);
        if (
          !isRecord(decoded) ||
          Object.keys(decoded).some(
            (key) => !["model", "answers", "usage"].includes(key),
          ) ||
          typeof decoded.model !== "string" ||
          !decoded.model.trim() ||
          !isRecord(decoded.answers)
        ) {
          return unavailable(
            requestedModel,
            checkedAt,
            Math.max(0, now() - startedAt),
            "invalid_response",
            true,
            usage,
            null,
            typeof decoded === "object" &&
              decoded !== null &&
              "model" in decoded &&
              typeof decoded.model === "string"
              ? decoded.model.trim()
              : null,
          );
        }
        const answerIds = Object.keys(decoded.answers);
        const expectedIds = Object.keys(prepared.questions);
        if (
          answerIds.length !== expectedIds.length ||
          expectedIds.some((id) => !answerIds.includes(id))
        ) {
          return unavailable(
            requestedModel,
            checkedAt,
            Math.max(0, now() - startedAt),
            "invalid_response",
            true,
            usage,
            null,
            typeof decoded === "object" &&
              decoded !== null &&
              "model" in decoded &&
              typeof decoded.model === "string"
              ? decoded.model.trim()
              : null,
          );
        }
        const probabilities = new Map<CheckId, number>();
        for (const id of expectedIds as CheckId[]) {
          const answer = decoded.answers[id];
          if (
            !isRecord(answer) ||
            !hasExactKeys(answer, ["type", "noul"]) ||
            answer.type !== "noul" ||
            typeof answer.noul !== "number" ||
            !Number.isFinite(answer.noul) ||
            answer.noul < 0 ||
            answer.noul > 1
          ) {
            return unavailable(
              requestedModel,
              checkedAt,
              Math.max(0, now() - startedAt),
              "invalid_response",
              true,
              usage,
              null,
              typeof decoded === "object" &&
                decoded !== null &&
                "model" in decoded &&
                typeof decoded.model === "string"
                ? decoded.model.trim()
                : null,
            );
          }
          probabilities.set(id, answer.noul);
        }
        const insufficient = new Set(prepared.insufficient);
        const checks: VerificationCheck[] = CHECK_IDS.map((id) =>
          insufficient.has(id)
            ? {
                id,
                fields: CHECK_FIELDS[id],
                assessment: "insufficient_evidence",
              }
            : {
                id,
                fields: CHECK_FIELDS[id],
                assessment: "assessed",
                probability: probabilities.get(id)!,
              },
        );
        const pricing = estimateTypeSafeCost(
          decoded.model,
          usage.inputTokens,
          usage.outputTokens,
        );
        return verificationResultSchema.parse({
          schemaVersion: 1,
          questionSetVersion: QUESTION_SET_VERSION,
          mode: "advisory",
          outcome: "completed",
          reason: null,
          requestedModel,
          actualModel: decoded.model.trim(),
          checkedAt,
          checks,
          numericDifferences: prepared.numericDifferences,
          usage: {
            ...usage,
            ...pricing,
            latencyMs: Math.max(0, now() - startedAt),
            requestAttempted: true,
          },
        });
      } catch (error) {
        const reason =
          error instanceof DeadlineError
            ? "timeout"
            : error instanceof ResponseLimitError ||
                error instanceof SyntaxError
              ? "invalid_response"
              : "network";
        return unavailable(
          requestedModel,
          checkedAt,
          Math.max(0, now() - startedAt),
          reason,
          true,
          usage,
        );
      } finally {
        clearTimeout(timeoutId!);
      }
    },
  };
}
